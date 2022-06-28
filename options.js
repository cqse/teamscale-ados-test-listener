'use strict';

const technologyElement = document.getElementById("technology");
const sapInputElement = document.getElementById("sap-input");
const tsProjectElement = document.getElementById("ts-project-input");
const tsServerDescriptionElement = document.getElementById("ts-server-description");
const webServerDescriptionElement = document.getElementById("web-server-description");

function loadDataAndListen() {
    chrome.storage.local.get(allOptionIds, result => {
        allOptionIds.forEach(optionId => {
            const optionInput = document.getElementById(optionId);
            optionInput.value = result[optionId];
            optionInput.addEventListener('input', saveChanges);
        });
        showTechnologyOptions();
    });
}


function saveChanges(inputElement) {
    let storageObject = {};
    storageObject[inputElement.target.id] = inputElement.target.value;

    chrome.storage.local.set(storageObject);
}

function showTechnologyOptions() {

    if (technologyElement.value == 'dotnet') {
        sapInputElement.hidden = true;
        tsProjectElement.hidden = true;
        tsServerDescriptionElement.hidden = true;
        webServerDescriptionElement.hidden = false;
    } else {
        sapInputElement.hidden = false;
        tsProjectElement.hidden = false;
        tsServerDescriptionElement.hidden = false;
        webServerDescriptionElement.hidden = true;
    }
}

technologyElement.addEventListener("change", showTechnologyOptions);

loadDataAndListen();