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
    
    if ( technology.value == 'dotnet')
      {
        sapInput.hidden = true ;
        tsProject.hidden = true;
      }     
        else
      {
        sapInput.hidden = false ;
        tsProject = false;
     }
}

loadDataAndListen();