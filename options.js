'use strict';

function loadDataAndListen() {
    chrome.storage.local.get(allOptionIds, result => {
        allOptionIds.forEach(optionId => {
            const optionInput = document.getElementById(optionId);
            optionInput.value = result[optionId];
            optionInput.addEventListener('input', saveChanges);
        });
    });
}


function saveChanges(inputElement) {
    let storageObject = {};
    storageObject[inputElement.target.id] = inputElement.target.value;

    chrome.storage.local.set(storageObject);
}

loadDataAndListen();