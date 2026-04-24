"use strict";

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');

const old_city_aa = 'CITYC3WWO5DD2UM6HQR3H333RRTD253Q';
const old_asset = 'HoKGB+QQ8+jZ4hZHqvZwNYcsrbP0Njztxn6t4BQro4M=';
const odex_aa = 'FVRZTCFXIDQ3EYRGQSLE5AMWUQF4PRYJ';
const new_city_aa = process.argv[2];

if (!new_city_aa) {
	console.error("Usage: node replicate.js <new_city_aa_address>");
	process.exit(1);
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchDirectHolders() {
	const url = `https://explorer.obyte.org/api/asset/${encodeURIComponent(old_asset)}/next_page_holders`;
	const res = await fetch(url);
	const data = await res.json();
	const holders = data.holders || [];
	console.error(`Direct holders: (${holders.length})`, holders);
	return holders;
}


async function fetchOdexHolders() {
	let holders = [];
	const vars = await dag.readAAStateVars(odex_aa, 'balance_');
	for (const var_name in vars) {
		const [, address, asset] = var_name.split('_');
		if (asset !== old_asset) continue;
		const balance = vars[var_name];
		if (balance > 0)
			holders.push({ address, balance });
	}
	console.error(`ODEX holders: (${holders.length})`, holders);
	return holders;
}

async function fetchHolders() {
	const direct_holders = await fetchDirectHolders();
	const odex_holders = await fetchOdexHolders();
	const balancesByAddress = new Map();

	for (const holder of [...direct_holders, ...odex_holders]) {
		const previousBalance = balancesByAddress.get(holder.address) || 0;
		balancesByAddress.set(holder.address, previousBalance + holder.balance);
	}

	const holders = Array.from(balancesByAddress, ([address, balance]) => ({ address, balance }));
	console.error(`Total holders: (${holders.length})`, holders);
	return holders;
}

async function isAA(address) {
	try {
		const definition = await dag.readAADefinition(address);
		return !!(definition && definition[0] === 'autonomous agent');
	}
	catch (e) {
		return false;
	}
}

async function replicateStateVars() {
	const vars = await dag.readAAStateVars(old_city_aa);
	const var_names = Object.keys(vars).filter(name => name !== 'constants');
	console.error(`Found ${var_names.length} state vars to replicate (excluding 'constants')`);

	for (const var_name of var_names) {
		console.error(`Replicating ${var_name} ...`);
		continue
		const unit = await dag.sendAARequest(new_city_aa, { var_name });
		if (unit)
			console.error(`Sent replication request for ${var_name}, unit: ${unit}`);
		else
			console.error(`Failed to send replication request for ${var_name}`);
		await wait(500);
	}

	console.error("All state var replication requests sent");
}

async function replicateBalances() {
	console.error("Fetching holders of the old CITY asset...");
	const holders = await fetchHolders();
	console.error(`Found ${holders.length} holders`);

	const userOutputs = [];
	for (const holder of holders) {
		const bIsAA = await isAA(holder.address);
		if (bIsAA) {
			console.error(`Skipping AA: ${holder.address}`);
			continue;
		}
		userOutputs.push({ address: holder.address, amount: holder.balance });
	}
	console.error(`${userOutputs.length} non-AA holders to replicate`, userOutputs);
	return;

	const unit = await dag.sendAARequest(new_city_aa, { outputs: userOutputs });
	if (unit)
		console.error(`Sent balance replication request, unit: ${unit}`);
	else
		console.error(`Failed to send balance replication request`);

	console.error("All balance replication requests sent");
}

async function work() {
	await operator.start();
	const my_address = operator.getAddress();
	console.error(`Operator address: ${my_address}`);
//	await replicateStateVars();
	await replicateBalances();
	process.exit();
}

work();
