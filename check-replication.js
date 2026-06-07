"use strict";

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const _ = require('lodash');

const old_city_aa = 'CITYC3WWO5DD2UM6HQR3H333RRTD253Q';
const new_city_aa = 'CITY22RWZTXX3UDPVQEDJLXM7BQNXCGP';


async function check() {
	const vars = await dag.readAAStateVars(old_city_aa);
	const new_vars = await dag.readAAStateVars(new_city_aa);
	console.error(Object.keys(vars).length, Object.keys(new_vars).length);
	delete vars.constants;
	delete new_vars.constants;
	console.error(_.isEqual(vars, new_vars));
}

async function work() {
	await operator.start();
	await check();
	process.exit();
}

work();
