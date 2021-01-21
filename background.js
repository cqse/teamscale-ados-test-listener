'use strict';

/* Enabled listeners that catch start of test run and Azure DevOps session that belongs to test run. */
let initialListeners = [];
/* Enabled listeners that catch update events of a test run. */
let listeners = [];

/* Map Chrome Tab Id to: URL of Test Run in Azure DevOps, subject to be displayed in Teamscale's Test Run View. */
let tabToAdosTestRunUrlMap = {};
/* Map Chrome Tab Id to: Test Case Id (not Test Run) as identified in Azure DevOps. */
let tabToTestCaseMap = {};
/* Map Test Case Id to: Parameters of the currently executed test run. Parameters are only sent on first update. */
let testParametersMap = {};

/* Map Chrome Tab Id to: Azure DevOps Session. This information currently unused. */
let tabToSessionMap = {};
/* Map Azure DevOps Session to: Azure DevOps User. This information is currently unused. */
let sessionToUserMap = {};

/* Options of the extension. Loaded once from the Chrome Storage. */
let configOptions = {};

/* Cookie of the active Teamscale session, needed for authenticated requests to Teamscale. */
let teamscaleSession;

/* Storage of all generated log messages (i.e. Test Events and Report Status Log Message from Teamscale. */
let logMessages = [];

const tsSapCallFinishedMsg = 'call finished';

const tsServerOptionName = 'ts-server';
const tsProjectOptionName = 'ts-project';
const sapUserOptionName = 'sap-username';
const extendedUriFilterOptionName = 'extended-uri-filter';
const allOptions = [tsServerOptionName, tsProjectOptionName, sapUserOptionName, extendedUriFilterOptionName];

const API_ON_PREMISE_CALL_OPEN_TEST_RUNNER = '/_api/_wit/pageWorkItems?__v=5';
const API_SERVICES_CALL_OPEN_TEST_RUNNER = '/_apis/Contribution/dataProviders/query';
const API_CALL_UPDATE_TEST_RUN_SUFFIX = '/_api/_testresult/Update?teamId=&__v=5';

const standardUriFilter = ["https://*.visualstudio.com/*", "https://dev.azure.com/*"];
let currentUriFilter = [];

chrome.runtime.onInstalled.addListener(() => {
	const standardValues = {};
	standardValues[tsServerOptionName] = 'https://teamscale.example.org/';
	standardValues[tsProjectOptionName] = 'project';
	standardValues[sapUserOptionName] = 'SAP_Sample_User';
	standardValues[extendedUriFilterOptionName] = '';

	allOptions.forEach(optionName => {
		let storageObject = {};
		storageObject[optionName] = standardValues[optionName];

		chrome.storage.local.set(storageObject);
	});
});

chrome.runtime.onMessage.addListener(
	function (request, sender, sendResponse) {
		if (request.data.request === 'send logs') {
			sendLogMessagesToPopup();
		}

		if (request.data.request === 'reset user') {
			queryTeamscale('reset');
		}

		if (request.data.request === 'get log') {
			queryTeamscale('log', null, null, null, request.data.sapTestKey);
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
		listeners[tabId] = (details) => testRunUpdateCallListener(details, tabId);

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
		queryTeamscale('stop', tabId);
	}
});

function registerInitialListeners(tabId) {
	fetchStoredConfiguration();

	initialListeners[tabId * 2] = resolveAzureDevOpsSessionIdListener;
	initialListeners[tabId * 2 + 1] = onStartListener;

	const listenerFilterOptions = {
		urls: currentUriFilter,
		types: ["xmlhttprequest"],
		tabId: tabId
	};

	chrome.webRequest.onBeforeSendHeaders.addListener(initialListeners[tabId * 2], listenerFilterOptions, ["requestHeaders", "extraHeaders"]);
	chrome.webRequest.onBeforeRequest.addListener(initialListeners[tabId * 2 + 1], listenerFilterOptions, ["requestBody"]);
}

function resolveAzureDevOpsSessionIdListener(details) {
	if (!isTestRunnerApiCall(details)) {
		return;
	}

	const headers = details.requestHeaders;

	for (let i = 0; i < headers.length; i++) {
		if (headers[i].name.toLowerCase() !== 'X-TFS-Session'.toLowerCase()) {
			continue;
		}

		tabToSessionMap[tabId] = headers[i].value;
	}

	// self delete this listener
	chrome.webRequest.onBeforeSendHeaders.removeListener(initialListeners[tabId * 2]);
	if (!tabToSessionMap[tabId]) {
		throw 'Could not obtain Azure DevOps Session ID.';
	}
}

function onStartListener(details) {
	if (!isTestRunnerApiCall(details)) {
		return;
	}

	let workItemId;
	let apiCallUserInfoUri;
	if (details.url.endsWith(API_ON_PREMISE_CALL_OPEN_TEST_RUNNER)) {
		workItemId = JSON.parse(String.fromCharCode.apply(null, new Uint8Array(details.requestBody.raw[0].bytes))).workItemIds;
		apiCallUserInfoUri = details.url.substring(0, details.url.length - API_ON_PREMISE_CALL_OPEN_TEST_RUNNER.length) +
			'/_api/_common/GetUserProfile?__v=5';
	} else {
		workItemId = JSON.parse(String.fromCharCode.apply(null, new Uint8Array(details.requestBody.raw[0].bytes))).context.properties.workItemIds;
		apiCallUserInfoUri = details.url.substring(0, details.url.length - API_SERVICES_CALL_OPEN_TEST_RUNNER.length) +
			'/_api/_common/GetUserProfile?__v=5';
	}

	tabToTestCaseMap[tabId] = workItemId;

	resolveUserNameOfTesterAndTriggerRecordingStart(apiCallUserInfoUri, tabId);

	// self delete this listener
	chrome.webRequest.onBeforeRequest.removeListener(initialListeners[tabId * 2 + 1]);
}

/**
 * This listener is attached to web requests in tabs that are assumed to belong to an Azure DevOps test runner and
 * parses needed information from update calls (regarding a test run) to Azure DevOps.
 */
function testRunUpdateCallListener(details, tabId) {
	if (!details.url.endsWith(API_CALL_UPDATE_TEST_RUN_SUFFIX)) {
		return;
	}

	let updateRequest = JSON.parse(JSON.parse(String.fromCharCode.apply(
		null, new Uint8Array(details.requestBody.raw[0].bytes))).updateRequests)[0];

	const testCaseId = updateRequest.testCaseResult.testCaseId;
	const updatedIterationActionResult = getUpdatedIterationActionResult(updateRequest);
	const testRunId = updateRequest.testRunId;

	tabToAdosTestRunUrlMap[tabId] = tab.url.substring(0, tab.url.indexOf('/_testExecution/')) +
		'/_testManagement/runs?runId=' + testRunId + '&_a=runCharts';

	if (!testParametersMap[testCaseId]) {
		testParametersMap[testCaseId] = getParameterDefinitionsPerIteration(updateRequest);
	}

	const testNameWithParameter = updateRequest.testCaseResult.testCaseTitle.trim();

	if (updatedIterationActionResult.outcome === 12) { // test is paused, other call to Teamscale needed
		queryTeamscale('pause', details.tabId, testNameWithParameter,
			testOutcomeToTeamscaleTestExecutionResult(updatedIterationActionResult.outcome));
	} else {
		queryTeamscale('update', details.tabId, testNameWithParameter,
			testOutcomeToTeamscaleTestExecutionResult(updatedIterationActionResult.outcome));
	}
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
	if (action !== 'reset' && action !== 'log' && (!tabId || !tabToTestCaseMap[tabId])) {
		throw 'Could not obtain testId from tabId "' + tabId + '".';
	}

	if (!configOptions[tsServerOptionName] || !configOptions[tsProjectOptionName] || !configOptions[sapUserOptionName]) {
		throw 'Not all extension configuration entries are set. (' +
		tsServerOptionName + '=' + configOptions[tsServerOptionName] + ', ' +
		tsProjectOptionName + '=' + configOptions[tsProjectOptionName] + ', ' +
		sapUserOptionName + '=' + configOptions[sapUserOptionName] + ')';
	}

	const testId = tabToTestCaseMap[tabId];

	if (action === 'update' && (!extendedName || !status)) {
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
	if (action === 'update') {
		additionalParameter = '&result=' + status + "&extended-name=" + encodeURI(extendedName);
	}

	const teamscaleUrl = assertStringEndsWith(configOptions[tsServerOptionName], '/');

	const testOutput = 'Follow this link to view test run in Azure DevOps:\n' + tabToAdosTestRunUrlMap[tabId];

	let url;
	let httpVerb = 'POST';
	const serviceUrl = teamscaleUrl + 'api/projects/' + configOptions[tsProjectOptionName] + '/sap-test-event/';

	if (action === 'reset') {
		url = serviceUrl + action + '/' + encodeURIComponent(configOptions[sapUserOptionName]);
	} else if (action === 'log') {
		httpVerb = 'GET';
		url = serviceUrl + action + '/' + encodeURIComponent(sapTestKey);
	} else {
		url = serviceUrl + action + '?test-id=' + testId + '&message=' + encodeURIComponent(testOutput) + '&sap-user-name=' + encodeURIComponent(configOptions[sapUserOptionName]) + additionalParameter;
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
		case 'start':
			return '▶️ Start Test';
		case 'stop':
			return '⏹️ End Test';
		case 'update':
			return '🗞️ Update Metadata';
		case 'log':
			return '🗞️ Log';
		case 'reset':
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

	text = text.replace(/ : .:\/CQSE\/MSG_TIA:000/gm, ':');
	return text;
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
	request.open("GET", apiUrl, true);
	request.onreadystatechange = () => {
		if (request.readyState !== 4) {
			return;
		}
		if (request.status === 200) {
			const userInfo = JSON.parse(request.responseText);
			sessionToUserMap[tabToSessionMap[tabId]] = userInfo.identity.AccountName;

			queryTeamscale('start', tabId);
		} else {
			throw 'Could not obtain username.';
		}
	}
	request.send();
}

function fetchStoredConfiguration() {
	chrome.storage.local.get(allOptions, result => {
		allOptions.forEach(optionName => {
			configOptions[optionName] = result[optionName];
		});

		currentUriFilter = standardUriFilter;
		if (configOptions[extendedUriFilterOptionName] && configOptions[extendedUriFilterOptionName].trim().length > 1) {
			currentUriFilter.push(configOptions[extendedUriFilterOptionName]);
		}
		cacheTeamscaleSessionCookie();
	});
}

function assertStringEndsWith(text, suffix) {
	if (text.endsWith(suffix)) {
		return text;
	}

	return text + suffix;
}

function cacheTeamscaleSessionCookie() {
	const teamscaleServer = new URL(configOptions[tsServerOptionName]);
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