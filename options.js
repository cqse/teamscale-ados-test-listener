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
    var sap = document.getElementById("sap");
    var dotnet = document.getElementById("dotnet");
    var sapInput = document.getElementById("sap-input");
    var dotnetInput = document.getElementById("dotnet-input")
    
    if ( technology.value == 'dotnet')
      {
        dotnetInput.hidden = false;
        sapInput.hidden = true ;
      }     
        else
      {
        dotnetInput.hidden = true;
        sapInput.hidden = false ;
     }
}

loadDataAndListen();