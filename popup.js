'use strict';

let listeners = [];

const tsSapCallFinishedMsg = 'call finished';

chrome.runtime.sendMessage({
	data: {
		request: 'send logs'
	}
});

chrome.runtime.onMessage.addListener(
	function (request, sender, sendResponse) {
		if (request.msg === tsSapCallFinishedMsg) {
			const messagesElement = 'messages';
			document.getElementById(messagesElement).innerHTML = formatServerResponse(request.data.serverResponse) +
				document.getElementById(messagesElement).innerHTML;
			const date = request.data.serverResponse.date;

			retainOnlyNewestOfSubsequentLogEntries(messagesElement);
			initializeResetLink(date);
			initializeLogLink(date);
			makeObjectInspectionCollapsible(date);
			listeners.forEach(listenerEntry => {
				document.getElementById(listenerEntry.elementId).addEventListener('click', listenerEntry.listener);
			});
		}
	}
);

function formatServerResponse(serverResponse) {
	let textParts = serverResponse.text.split('ManualSapTestInfo');
	let text = textParts[0];
	if (textParts.length > 1) {
		text = textParts[0] +
			'<div id="' + serverResponse.date + '-teaser">ManualSapTestInfo [<span style="color: darkgray">click to' +
			' inspect</span>]</div>' +
			'<div id="' + serverResponse.date + '-info" style="display: none">' +
			'ManualSapTestInfo' + textParts[1].replace('[', '[<br>&nbsp;&nbsp;&nbsp;').replace(/, /g, '<br>&nbsp;&nbsp;&nbsp;') + '</div>';
	}

	text = text.replace(/(?:\r\n|\r|\n)/g, '<br>');

	const resetUserStateUrl = 'api/projects/{project}/sap-test-event/reset/{sap-user}';
	text = text.replace(resetUserStateUrl, resetUserStateUrl + ' (<span class="reset-link" id="' + serverResponse.date + '-reset">click' +
		' here to send request now)</span>');

	const testKeyPrefix = 'Test identifier: ';
	const testKeyPostfix = ' get log via api/projects/{project}/sap-test-event/log/{sap-test-key}.';
	text = text.replace(testKeyPrefix, '<span class="log-link" id="' + serverResponse.date + '-log" data-test-key="');
	text = text.replace(testKeyPostfix, '">Click to retrieve/update log.</span>');

	text.replace(':/CQSE/MSG_TIA:000 ', '');

	let labelsClasses = 'labels';
	if (serverResponse.status !== 200) {
		labelsClasses += ' error';
	}

	return "<div class='" + labelsClasses + "'><div class='label'>" + serverResponse.action + "</div><div class='label'" +
		" style='float:" +
		" right'>" + serverResponse.date + "</div></div><p class='message'>" + text + "</p>";
}

function initializeLogLink(date) {
	const logLink = document.getElementById(date + '-log');
	if (!logLink) {
		return;
	}

	const listener = {
		elementId: logLink.id, listener: () => {
			chrome.runtime.sendMessage({
				data: {
					request: 'get log',
					sapTestKey: logLink.getAttribute('data-test-key')
				}
			});
		}
	};
	listeners.push(listener);

}

function initializeResetLink(date) {
	const resetLink = document.getElementById(date + '-reset');
	if (!resetLink) {
		return;
	}

	const listener = {
		elementId: resetLink.id, listener: () => {
			chrome.runtime.sendMessage({
				data: {
					request: 'reset user'
				}
			});
		}
	};
	listeners.push(listener);

}

function makeObjectInspectionCollapsible(date) {
	const infoElement = document.getElementById(date + '-info');
	if (infoElement) {
		listeners.push({elementId: infoElement.id, listener: () => triggerMoreInfo(date)});
	}

	const teaserElement = document.getElementById(date + '-teaser');
	if (teaserElement) {
		listeners.push({elementId: teaserElement.id, listener: () => triggerMoreInfo(date)});
	}
}

function triggerMoreInfo(elementIdPrefix) {
	const infoElement = document.getElementById(elementIdPrefix + '-info');
	const teaserElement = document.getElementById(elementIdPrefix + '-teaser');
	if (infoElement.style.display === 'none') {
		infoElement.style.display = 'block';
		teaserElement.style.display = 'none';
	} else {
		infoElement.style.display = 'none';
		teaserElement.style.display = 'block';
	}
}

function retainOnlyNewestOfSubsequentLogEntries(messagesElement) {
	const messagesChildren = document.getElementById(messagesElement).children;
	if (messagesChildren.length >= 4) {
		if (messagesChildren[0].innerHTML.includes('Log</') && messagesChildren[2].innerHTML.includes('Log</')) {
			document.getElementById(messagesElement).removeChild(messagesChildren[3]);
			document.getElementById(messagesElement).removeChild(messagesChildren[2]);
		}
	}
}
