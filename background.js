'use strict';

/* Enabled listeners that resolve Azure DevOps session that belongs to test run. */
let adosSessionIdResolvingListener = [];
/* Enabled listeners that catch start of test run. */
let onTestStartListeners = [];
/* Enabled listeners that catch update events of a test run. */
let listeners = [];

/* Map Chrome Tab Id to: URL of Test Run in Azure DevOps, subject to be displayed in Teamscale's Test Run View. */
let adosTestRunUrlByTab = {};
/* Map Chrome Tab Id to: Test Case Id (not Test Run) as identified in Azure DevOps. */
let testCaseIdByTab = {};
/* Map Test Case Id to: Parameters of the currently executed test run. Parameters are only sent on first update. */
let testParametersByTestCaseId = {};

/* Map Chrome Tab Id to: Azure DevOps Session. This information currently unused. */
let adosSessionByTab = {};
/* Map Azure DevOps Session to: Azure DevOps User. This information is currently unused. */
let userByAdosSession = {};

/* Options of the extension. Loaded once from the Chrome Storage. */
let configOptions = {};

/* Cookie of the active Teamscale session, needed for authenticated requests to Teamscale. */
let teamscaleSession;

/* Storage of all generated log messages (i.e. Test Events and Report Status Log Message from Teamscale. */
let logMessages = [];

const API_ON_PREMISE_CALL_OPEN_TEST_RUNNER = '/_api/_wit/pageWorkItems?__v=5';
const API_SERVICES_CALL_OPEN_TEST_RUNNER = '/_apis/Contribution/dataProviders/query';
const API_CALL_UPDATE_TEST_RUN_SUFFIX = '/_api/_testresult/Update?teamId=&__v=5';

const standardUriFilter = ['https://*.visualstudio.com/*', 'https://dev.azure.com/*'];
let currentUriFilter = [];

chrome.runtime.onInstalled.addListener(fetchStoredConfiguration);

chrome.runtime.onMessage.addListener(
	function (request, sender, sendResponse) {
		if (request.data.request === internalRequestKinds.sendLogs) {
			sendLogMessagesToPopup();
		}

		if (request.data.request === internalRequestKinds.resetUser) {
			queryTeamscale(tsTiaApiActions.reset);
		}

		if (request.data.request === internalRequestKinds.getLog) {
			queryTeamscale(tsTiaApiActions.log, null, null, null, request.data.sapTestKey);
		}
	}
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (!changeInfo.status || changeInfo.status !== 'complete' ||
		!(tab.title.startsWith('Runner') && tab.title.endsWith('Test Plans'))) {
		return;
	}

	registerInitialListeners(tabId);

	if (listeners[tabId]) {
		chrome.webRequest.onBeforeRequest.removeListener(listeners[tabId]);
		delete listeners[tabId];
	} else {
		listeners[tabId] = details => testRunUpdateCallListener(details, tabId, tab);

		chrome.webRequest.onBeforeRequest.addListener(listeners[tabId], {
			urls: currentUriFilter,
			types: ["xmlhttprequest"],
			tabId: tabId
		}, ["requestBody"]);
	}
});

// Remove obsolete listener when the tab is closed.
chrome.tabs.onRemoved.addListener(tabId => {
	if (listeners[tabId]) {
		chrome.webRequest.onBeforeRequest.removeListener(listeners[tabId]);
		delete listeners[tabId];
		queryTeamscale(tsTiaApiActions.stop, tabId);
	}
});

function registerInitialListeners(tabId) {
	fetchStoredConfiguration();
	cacheTeamscaleSessionCookie();

	adosSessionIdResolvingListener[tabId] = details => resolveAzureDevOpsSessionIdListener(details, tabId);
	onTestStartListeners[tabId] = details => onStartListener(details, tabId);

	const listenerFilterOptions = {
		urls: currentUriFilter,
		types: ["xmlhttprequest"],
		tabId: tabId
	};

	chrome.webRequest.onBeforeSendHeaders.addListener(adosSessionIdResolvingListener[tabId], listenerFilterOptions, ["requestHeaders", "extraHeaders"]);
	chrome.webRequest.onBeforeRequest.addListener(onTestStartListeners[tabId], listenerFilterOptions, ["requestBody"]);
}

function resolveAzureDevOpsSessionIdListener(details, tabId) {
	if (!isTestRunnerApiCall(details)) {
		return;
	}

	const headers = details.requestHeaders;

	for (let i = 0; i < headers.length; i++) {
		if (headers[i].name.toLowerCase() !== 'X-TFS-Session'.toLowerCase()) {
			continue;
		}

		adosSessionByTab[tabId] = headers[i].value;
	}

	// self delete this listener
	chrome.webRequest.onBeforeSendHeaders.removeListener(adosSessionIdResolvingListener[tabId]);
	if (!adosSessionByTab[tabId]) {
		throw 'Could not obtain Azure DevOps Session ID.';
	}
}

function onStartListener(details, tabId) {
	if (!isTestRunnerApiCall(details)) {
		return;
	}

	let workItemId;
	let caughtCall;
	const parsedRequest = JSON.parse(String.fromCharCode.apply(null, new Uint8Array(details.requestBody.raw[0].bytes)));

	if (details.url.endsWith(API_ON_PREMISE_CALL_OPEN_TEST_RUNNER)) {
		workItemId = parsedRequest.workItemIds;
		caughtCall = API_ON_PREMISE_CALL_OPEN_TEST_RUNNER;
	} else {
		workItemId = parsedRequest.context.properties.workItemIds;
		caughtCall = API_SERVICES_CALL_OPEN_TEST_RUNNER;
	}

	testCaseIdByTab[tabId] = workItemId;

	const apiCallUserInfoUri = details.url.substring(0, details.url.length - caughtCall.length) + '/_api/_common/GetUserProfile?__v=5';
	resolveUserNameOfTesterAndTriggerRecordingStart(apiCallUserInfoUri, tabId);

	// self delete this listener
	chrome.webRequest.onBeforeRequest.removeListener(onTestStartListeners[tabId]);
}

/**
 * This listener is attached to web requests in tabs that are assumed to belong to an Azure DevOps test runner and
 * parses needed information from update calls (regarding a test run) to Azure DevOps.
 */
function testRunUpdateCallListener(details, tabId, tab) {
	if (!details.url.endsWith(API_CALL_UPDATE_TEST_RUN_SUFFIX)) {
		return;
	}

	let updateRequest = JSON.parse(JSON.parse(String.fromCharCode.apply(
		null, new Uint8Array(details.requestBody.raw[0].bytes))).updateRequests)[0];

	const testCaseId = updateRequest.testCaseResult.testCaseId;
	const updatedIterationActionResult = getUpdatedIterationActionResult(updateRequest);
	const testRunId = updateRequest.testRunId;

	adosTestRunUrlByTab[tabId] = tab.url.substring(0, tab.url.indexOf('/_testExecution/')) +
		'/_testManagement/runs?runId=' + testRunId + '&_a=runCharts';

	if (!testParametersByTestCaseId[testCaseId]) {
		testParametersByTestCaseId[testCaseId] = getParameterDefinitionsPerIteration(updateRequest);
	}

	const testNameWithParameter = updateRequest.testCaseResult.testCaseTitle.trim();

	let action = tsTiaApiActions.update;
	if (updatedIterationActionResult.outcome === 12) { // test is paused, other call to Teamscale needed
		action = tsTiaApiActions.pause;
	}

	queryTeamscale(action, details.tabId, testNameWithParameter, testOutcomeToTeamscaleTestExecutionResult(updatedIterationActionResult.outcome));
}

/**
 * Object returned carries property "outcome" that describes the testing result as integer which can be interpreted by
 * {@link testOutcomeToTeamscaleTestExecutionResult}.
 */
function getUpdatedIterationActionResult(updateRequest) {
	let result;

	for (let i = 0; i < updateRequest.actionResults.length; i++) {
		const actionResult = updateRequest.actionResults[i];

		if (isSubstepInfo(actionResult)) {
			continue;
		}

		if (!result || getCompletedDateOfActionResult(result) < getCompletedDateOfActionResult(actionResult)) {
			result = actionResult;
		}
	}

	return result;
}

function getParameterDefinitionsPerIteration(updateRequest) {
	let parametersPerIteration = {};

	for (let i = 0; i < updateRequest.parameters.length; i++) {
		const parameter = updateRequest.parameters[i];

		if (isSubstepInfo(parameter)) {
			continue;
		}

		if (!parametersPerIteration[parameter.iterationId]) {
			parametersPerIteration[parameter.iterationId] = new Set();
		}

		const parameterNameAndValue = parameter.parameterName + '=' + parameter.expected;
		parametersPerIteration[parameter.iterationId].add(parameterNameAndValue);
	}

	return parametersPerIteration;
}

function queryTeamscale(action, tabId, extendedName, status, sapTestKey) {
	if (action !== tsTiaApiActions.reset && action !== tsTiaApiActions.log && (!tabId || !testCaseIdByTab[tabId])) {
		throw 'Could not obtain testId from tabId "' + tabId + '".';
	}

	if (!configOptions[tsServerOptionId] || !configOptions[tsProjectOptionId] || !configOptions[sapUserOptionId]) {
		throw 'Not all extension configuration entries are set. (' +
		tsServerOptionId + '=' + configOptions[tsServerOptionId] + ', ' +
		tsProjectOptionId + '=' + configOptions[tsProjectOptionId] + ', ' +
		sapUserOptionId + '=' + configOptions[sapUserOptionId] + ')';
	}

	const testId = testCaseIdByTab[tabId];

	if (action === tsTiaApiActions.update && (!extendedName || !status)) {
		throw 'Need test name and status for updating Test Run.';
	}

	const request = constructTeamscaleRequest(action, status, extendedName, tabId, sapTestKey, testId);
	request.setRequestHeader('X-Requested-By', teamscaleSession);

	request.onreadystatechange = () => handleTeamscaleResponse(request, action);
	request.send();
}

function constructTeamscaleRequest(action, status, extendedName, tabId, sapTestKey, testId) {
	const request = new XMLHttpRequest();

	let additionalParameter = '';
	if (action === tsTiaApiActions.update) {
		additionalParameter = '&result=' + status + "&extended-name=" + encodeURI(extendedName);
	}

	const teamscaleUrl = assertStringEndsWith(configOptions[tsServerOptionId], '/');

	const testOutput = 'Follow this link to view test run in Azure DevOps:\n' + adosTestRunUrlByTab[tabId];

	let url;
	let httpVerb = 'POST';
	const serviceUrl = teamscaleUrl + 'api/projects/' + configOptions[tsProjectOptionId] + '/sap-test-event/';

	if (action === tsTiaApiActions.reset) {
		url = serviceUrl + action + '/' + encodeURIComponent(configOptions[sapUserOptionId]);
	} else if (action === tsTiaApiActions.log) {
		httpVerb = 'GET';
		url = serviceUrl + action + '/' + encodeURIComponent(sapTestKey);
	} else {
		url = serviceUrl + action + '?test-id=' + testId + '&message=' + encodeURIComponent(testOutput) + '&sap-user-name=' + encodeURIComponent(configOptions[sapUserOptionId]) + additionalParameter;
	}

	request.open(httpVerb, url, true);
	return request;
}

function handleTeamscaleResponse(request, action) {
	if (request.readyState !== 4) {
		return;
	}

	const actionString = resolveActionCaption(action);
	const text = resolveEventText(request);
	const event = {
		action: actionString,
		status: request.status,
		date: new Date().toLocaleString(),
		text: text
	};

	persistAndBroadcastSingleEvent(event);
}

function resolveActionCaption(action) {
	switch (action) {
		case tsTiaApiActions.start:
			return '▶️ Start Test';
		case tsTiaApiActions.stop:
			return '⏹️ End Test';
		case tsTiaApiActions.update:
			return '🗞️ Update Metadata';
		case tsTiaApiActions.log:
			return '🗞️ Log';
		case tsTiaApiActions.reset:
			return '🔄 Reset Recording State';
		default:
			return 'Test Event';
	}
}

function resolveEventText(request) {
	let text = request.responseText;
	if (request.status !== 200) {
		const textParts = text.substr(text.indexOf('HTTP Status Code')).split('\n');
		text = textParts[0] + '\r\n' + textParts[1];

		if (request.status === 401) {
			text = 'Please log in to Teamscale first: ' + teamscaleUrl + '\r\n\r\n' + text;
		}
	}

	return text.replace(/ : .:\/CQSE\/MSG_TIA:000/gm, ':');
}

function persistAndBroadcastSingleEvent(event) {
	logMessages.push(event);

	chrome.runtime.sendMessage({
		msg: tsSapCallFinishedMsg,
		data: {
			serverResponse: event
		}
	});

	chrome.notifications.create('TS SAP TW Coverage', {
		type: 'basic',
		title: event.action,
		iconUrl: 'images/ados_test_listener96.png',
		message: event.text
	});
}

function resolveUserNameOfTesterAndTriggerRecordingStart(apiUrl, tabId) {
	const request = new XMLHttpRequest();
	request.open('GET', apiUrl, true);
	request.onreadystatechange = () => {
		// readyState==4 => DONE; see https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/readyState
		if (request.readyState !== 4) {
			return;
		}
		if (request.status === 200) {
			const userInfo = JSON.parse(request.responseText);
			userByAdosSession[adosSessionByTab[tabId]] = userInfo.identity.AccountName;

			queryTeamscale(tsTiaApiActions.start, tabId);
		} else {
			throw 'Could not obtain username.';
		}
	};
	request.send();
}

function fetchStoredConfiguration() {
	chrome.storage.local.get(allOptionIds, result => {
		if (!result[tsProjectOptionId]) {
			setDefaultOptions();
			return;
		}

		allOptionIds.forEach(optionId => {
			configOptions[optionId] = result[optionId];
		});

		currentUriFilter = standardUriFilter;
		const extendedUriFilterSetting = configOptions[extendedUriFilterOptionId];
		if (extendedUriFilterSetting && extendedUriFilterSetting.trim().length > 1) {
			currentUriFilter.push(extendedUriFilterSetting);
		}
	});
}

function assertStringEndsWith(text, suffix) {
	if (text.endsWith(suffix)) {
		return text;
	}

	return text + suffix;
}

function cacheTeamscaleSessionCookie() {
	const teamscaleServer = new URL(configOptions[tsServerOptionId]);
	const setTeamscaleSessionCallback = function (cookieArray) {
		for (const cookie of cookieArray) {
			if (!(cookie.name.includes('teamscale-session') && cookie.name.includes('-' + teamscaleServer.port))) {
				continue;
			}

			teamscaleSession = cookie.name + '=' + cookie.value;
			return;
		}
	};

	chrome.cookies.getAll({'domain': teamscaleServer.hostname}, setTeamscaleSessionCallback);
}

function sendLogMessagesToPopup() {
	logMessages.forEach(element => {
		chrome.runtime.sendMessage({
			msg: tsSapCallFinishedMsg,
			data: {
				serverResponse: element
			}
		});
	});
}

function testOutcomeToTeamscaleTestExecutionResult(outcome) {
	switch (outcome) {
		case 2: // PASSED (Azure DevOps test state)
			return 'PASSED';
		case 3: // FAILED (Azure DevOps test state)
			return 'FAILURE';
		case 7: // BLOCKED (Azure DevOps test state)
			return 'SKIPPED';
		case 11: // NA (Azure DevOps test state)
		case 12: // PAUSED (Azure DevOps test state)
		default:
			return 'ERROR';
	}
}

function getCompletedDateOfActionResult(actionResult) {
	const dateString = actionResult.dateCompleted;
	const timestamp = dateString.substring(dateString.indexOf('(') + 1, dateString.indexOf(')'));
	return timestamp;
}

function isSubstepInfo(info) {
	// actionResult.actionPath.isEmpty is equivalent to actionResult.actionId !== 0
	return info.actionPath.length > 0;
}

function isTestRunnerApiCall(details) {
	return details.url.endsWith(API_ON_PREMISE_CALL_OPEN_TEST_RUNNER) ||
		details.url.endsWith(API_SERVICES_CALL_OPEN_TEST_RUNNER);
}

function setDefaultOptions() {
	const standardValues = {};
	standardValues[tsServerOptionId] = 'https://teamscale.example.org/';
	standardValues[tsProjectOptionId] = 'project';
	standardValues[sapUserOptionId] = 'SAP_Sample_User';
	standardValues[extendedUriFilterOptionId] = '';

	allOptionIds.forEach(optionIds => {
		let storageObject = {};
		storageObject[optionIds] = standardValues[optionIds];

		chrome.storage.local.set(storageObject);
	});
}