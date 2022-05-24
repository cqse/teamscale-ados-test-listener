'use strict';

const tsServerOptionId = 'ts-server';
const tsProjectOptionId = 'ts-project';
const technologyId = 'technology';
const sapUserOptionId = 'sap-username';
const extendedUriFilterOptionId = 'extended-uri-filter';
const allOptionIds = [tsServerOptionId, tsProjectOptionId, technologyId, sapUserOptionId, extendedUriFilterOptionId];

const tsSapCallFinishedMsg = 'call finished';

const httpOkStatus = 200;

const internalRequestKinds = {
	sendLogs: 'send logs',
	getLog: 'get log',
	resetUser: 'reset user'
};

const tsTiaApiActions = {
	start: 'start',
	stop: 'stop',
	pause: 'pause',
	update: 'update',
	log: 'log',
	reset: 'reset'
};

const technologies = {
	dotnet: 'dotnet',
	sap: 'SAP'
};