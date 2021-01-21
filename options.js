'use strict';

const tsServerOptionName = 'ts-server';
const tsProjectOptionName = 'ts-project';
const sapUserOptionName = 'sap-username';
const extendedUriFilterOptionName = 'extended-uri-filter';
const allOptions = [tsServerOptionName, tsProjectOptionName, sapUserOptionName, extendedUriFilterOptionName];

function loadDataAndListen() {
    chrome.storage.local.get(allOptions, result => {
        allOptions.forEach(optionName => {
            const optionInput = document.getElementById(optionName);
            optionInput.value = result[optionName];
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