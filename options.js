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

function showTechnologyOptions(){
    var technology = document.getElementById("technology");
    var sapInput = document.getElementById("sap-input");
    var tsProject = document.getElementById("ts-project-input");
    var tsServerDescription = document.getElementById("ts-server-description");
    var webServerDescription = document.getElementById("web-server-description");

    if ( technology.value == 'dotnet')
      {
        sapInput.hidden = true ;
        tsProject.hidden = true;
        tsServerDescription.hidden = true;
        webServerDescription.hidden = false;
      }     
        else
      {
        sapInput.hidden = false ;
        tsProject.hidden = false;
        tsServerDescription.hidden = false;
        webServerDescription.hidden = true;
     }
}

document.getElementById("technology").addEventListener("change", showTechnologyOptions);

loadDataAndListen();