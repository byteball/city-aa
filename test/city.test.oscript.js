// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const path = require('path')
const { promisify } = require('util')
const fs = require('fs')
const objectHash = require("ocore/object_hash.js");
const parseOjson = require('ocore/formula/parse_ojson').parse
const { vrfGenerate } = require('ocore/signature.js')

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}

function wait(ms) {
	return new Promise(r => setTimeout(r, ms))
}

describe('City', function () {
	this.timeout(240000)

	before(async () => {

		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ governance_base: path.join(__dirname, '../governance.oscript') })
			.with.agent({ lib: path.join(__dirname, '../city-lib.oscript') })
			.with.agent({ random_base: path.join(__dirname, '../random.oscript') })
			.with.wallet({ alice: 1000e9 })
			.with.wallet({ bob: 1000e9 })
			.with.wallet({ founder: 1e9 })
			.with.wallet({ attestor: 1e9 })
			.with.wallet({ vrfOracle: 1e9 })
		//	.with.explorer()
			.run()
		
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()

		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		
		this.founder = this.network.wallet.founder
		this.founderAddress = await this.founder.getAddress()
		
		this.attestor = this.network.wallet.attestor
		this.attestorAddress = await this.attestor.getAddress()
		
		this.vrfOracle = this.network.wallet.vrfOracle
		this.vrfOracleAddress = await this.vrfOracle.getAddress()

		this.plot_price = 1000e9
		this.matching_probability = 0.05

		this.random_oracle_earnings = 0
		this.bounce_fees = 0

		this.launchDate = new Date()
		this.launchDate.setMonth(this.launchDate.getMonth() + 1) // add 1 month

		this.timetravel = async (shift = '1d') => {
			const { error, timestamp } = await this.network.timetravel({ shift })
			expect(error).to.be.null
			return timestamp
		}

		this.timetravelToDate = async (to) => {
			const { error, timestamp } = await this.network.timetravel({ to })
			expect(error).to.be.null
		}

		this.executeGetter = async (aa, getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress: aa,
				getter,
				args
			})
			if (error)
				console.log(error)
			expect(error).to.be.null
			return result
		}

		this.getAmountToBuy = (bPrelaunch) => {
			const referral_boost = 0.1
			const buy_fee = 2 * (1 + referral_boost) * this.matching_probability / (1 - 4 * this.matching_probability);
			const price = Math.ceil(this.plot_price * (1 + buy_fee))
			const bought_tokens = bPrelaunch ? 0.1 * this.plot_price : 0
			const amount = Math.round((price + bought_tokens) / (bPrelaunch ? 1000 : 1))
			return amount
		}

		this.are_neighbors = async (plot1_num, plot2_num) => {
			return await this.executeGetter(this.city_aa, 'are_neighbors', [plot1_num, plot2_num])
		}

		this.generateRandomness = async (plot_num) => {
			const seed = this.city_aa + '-' + plot_num
			const privkey = fs.readFileSync(path.join(__dirname, 'privkey.pem'), 'utf8')
			const proof = vrfGenerate(seed, privkey)
		//	console.log({ proof })
		//	await wait(500)
		//	const proof2 = vrfGenerate(seed, privkey)
		//	console.log({ proof2 })
		//	expect(proof2).to.eq(proof)
			const { unit, error } = await this.vrfOracle.triggerAaWithData({
				toAddress: this.randomness_aa_address,
				amount: 10000,
				data: {
					req_id: plot_num,
					proof,
					consumer_aa: this.city_aa,
				},
			})
		//	console.log({error, unit})
			expect(error).to.be.null
			expect(unit).to.be.validUnit
			this.random_oracle_earnings += this.plot_price * 0.001
			this.bounce_fees += 10000
			return { unit, seed }
		}

	})

	it('Deploy random oracle', async () => {
		const pubkey = fs.readFileSync(path.join(__dirname, 'pubkey.pem'), 'utf8')
		const { address, error } = await this.founder.deployAgent({
			base_aa: this.network.agent.random_base,
			params: {
				vrf_providers: {
					[this.vrfOracleAddress]: pubkey,
				},
				finishing_provider: this.vrfOracleAddress,
			}
		})
		expect(error).to.be.null
		this.randomness_aa_address = address
	})

	it('Deploy City AA', async () => {
		let city = fs.readFileSync(path.join(__dirname, '../city.oscript'), 'utf8');
		city = city.replace(/\$lib_aa = '\w{32}'/, `$lib_aa = '${this.network.agent.lib}'`)
		city = city.replace(/randomness_aa: '\w*'/, `randomness_aa: '${this.randomness_aa_address}'`)
		city = city.replace(/attestors: '\w*'/, `attestors: '${this.attestorAddress}'`)
		city = city.replace(/\$fundraise_recipient = '\w*'/, `$fundraise_recipient = '${this.founderAddress}'`)
		city = city.replace(/\$launch_date = '[0-9-]*'/, `$launch_date = '${this.launchDate.toISOString().slice(0, 10)}'`)

		const { address, error } = await this.founder.deployAgent(city)
		console.log(error)
		expect(error).to.be.null
		this.city_aa = address
	})


	it('Founder defines the token', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		const { unit, error } = await this.founder.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				define: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.founder, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		this.asset = response.response.responseVars.asset

		const { vars } = await this.founder.readAAStateVars(this.city_aa)
		this.governance_aa = vars.constants.governance_aa
		expect(this.governance_aa).to.be.validAddress
	})


	it('Alice tries to buy land while not being attested', async () => {
		const amount = this.getAmountToBuy(true)
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: amount,
			data: {
				buy: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
		expect(response.response.error).to.eq("your address must be attested")
	})

	
	it('Attest alice', async () => {
		const { unit, error } = await this.attestor.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.aliceAddress,
					profile: {
						username: 'alice',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Alice buys land', async () => {
		const bought_tokens = 0.1 * this.plot_price
		const amount = this.getAmountToBuy(true)
		console.log(`paying ${amount/1e9} GB`)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: amount,
			data: {
				buy: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.plot_num).to.eq(1)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: bought_tokens,
			},
		])
		const timestamp = unitObj.timestamp
		this.start_ts = timestamp

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars.city_city).to.deep.eq({
			count_plots: 1,
			count_houses: 0,
			total_land: this.plot_price,
			total_bought: this.plot_price,
			total_rented: 0,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})
		expect(vars.plot_1).to.deep.eq({
			status: 'pending',
			amount: this.plot_price,
			city: 'city',
			ts: timestamp,
			owner: this.aliceAddress,
			username: 'alice',
		})
	})


	it("Random oracle determines the plot's location", async () => {
		const { unit, seed } = await this.generateRandomness(1)

		const { response } = await this.network.getAaResponseToUnitOnNode(this.vrfOracle, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		const { vars: rand_vars } = await this.vrfOracle.readAAStateVars(this.randomness_aa_address)
		expect(rand_vars['finished_' + seed]).to.eq(1)
		expect(rand_vars['bounce_fees_' + this.vrfOracleAddress]).to.eq(this.bounce_fees)
		expect(rand_vars['total_bounce_fees']).to.eq(this.bounce_fees)

		const { vars } = await this.vrfOracle.readAAStateVars(this.city_aa)
		console.log('plot_1', vars.plot_1)
		expect(vars.plot_1.status).to.eq('land')
		expect(vars.plot_1.x).to.gte(0)
		expect(vars.plot_1.y).to.gte(0)
		this.plot1 = vars.plot_1
	})


	it('Attest bob', async () => {
		const { unit, error } = await this.attestor.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.bobAddress,
					profile: {
						username: 'bob',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Bob buys land until he becomes a neighbor with Alice', async () => {
		const bought_tokens = 0.1 * this.plot_price
		const amount = this.getAmountToBuy(true)
		console.log(`paying ${amount / 1e9} GB`)
		let plot_num = 1
		let last_vacated_plot_num = 1
		let total_land = this.plot_price
		let count_plots = 1
		let bob_land = 0
		let bob_plot

		while (true) {
			plot_num++
			console.log(`bob buying plot ${plot_num}`)
			const { unit: buy_unit, error: buy_error } = await this.bob.triggerAaWithData({
				toAddress: this.city_aa,
				amount: amount,
				data: {
					buy: 1
				},
			})
		//	console.log({ buy_error, unit: buy_unit })
			expect(buy_error).to.be.null
			expect(buy_unit).to.be.validUnit
			await this.network.sync()

			// generate and send randomness
			const { unit: rand_unit, seed } = await this.generateRandomness(plot_num)
			total_land += this.plot_price
			count_plots++
			bob_land += this.plot_price

	
			const { response: buy_response } = await this.network.getAaResponseToUnitOnNode(this.bob, buy_unit)
			expect(buy_response.response.error).to.be.undefined
			expect(buy_response.bounced).to.be.false
			expect(buy_response.response_unit).to.be.validUnit
			expect(buy_response.response.responseVars.plot_num).to.eq(plot_num)

			const { unitObj } = await this.bob.getUnitInfo({ unit: buy_response.response_unit })
			expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
				{
					asset: this.asset,
					address: this.bobAddress,
					amount: bought_tokens,
				},
			])
			const timestamp = unitObj.timestamp

			const { response: rand_response } = await this.network.getAaResponseToUnitOnNode(this.vrfOracle, rand_unit)
			expect(rand_response.response.error).to.be.undefined
			expect(rand_response.bounced).to.be.false
			expect(rand_response.response_unit).to.be.validUnit
	
			const { vars: rand_vars } = await this.vrfOracle.readAAStateVars(this.randomness_aa_address)
			expect(rand_vars['finished_' + seed]).to.eq(1)
			expect(rand_vars['bounce_fees_' + this.vrfOracleAddress]).to.eq(this.bounce_fees)
			expect(rand_vars['total_bounce_fees']).to.eq(this.bounce_fees)
	
			const { vars: city_vars } = await this.vrfOracle.readAAStateVars(this.city_aa)
		//	console.log(plot_num, city_vars['plot_' + plot_num])
			expect(city_vars['plot_' + plot_num].status).to.eq('land')
			expect(city_vars['plot_' + plot_num].city).to.eq('city')
			expect(city_vars['plot_' + plot_num].amount).to.eq(this.plot_price)
			expect(city_vars['plot_' + plot_num].ts).to.eq(timestamp)
			expect(city_vars['plot_' + plot_num].owner).to.eq(this.bobAddress)
			expect(city_vars['plot_' + plot_num].x).to.gte(0)
			expect(city_vars['plot_' + plot_num].y).to.gte(0)
	
			expect(city_vars['user_land_' + this.bobAddress]).to.eq(bob_land)
			expect(city_vars['user_land_city_' + this.bobAddress]).to.eq(bob_land)
	
			expect(city_vars['rand_provider_balance_' + this.randomness_aa_address]).to.eq(this.random_oracle_earnings)

			expect(city_vars.city_city).to.deep.eq({
				count_plots: count_plots,
				count_houses: 0,
				total_land: total_land,
				total_bought: this.plot_price * plot_num,
				total_rented: 0,
				start_ts: this.start_ts,
				mayor: this.founderAddress,
			})
			expect(city_vars.state).to.deep.eq({
				last_house_num: 0,
				last_plot_num: plot_num,
				total_land: total_land,
			})

			const bNeighbors = await this.are_neighbors(1, plot_num)
			console.log(`plots 1 and ${plot_num} are neighbors? ${bNeighbors}`);
			if (bNeighbors) {
				bob_plot = city_vars['plot_' + plot_num]
				break;
			}

			// leave old unmatched plots to prevent the matching probability from decreasing further
			if (total_land >= 2 * this.plot_price) {
				last_vacated_plot_num++
				console.log(`bob vacating plot ${last_vacated_plot_num}`)
				const { unit, error } = await this.bob.triggerAaWithData({
					toAddress: this.city_aa,
					amount: 10000,
					data: {
						leave: 1,
						plot_num: last_vacated_plot_num,
					},
				})
				expect(error).to.be.null
				expect(unit).to.be.validUnit

				total_land -= this.plot_price
				count_plots--
				bob_land -= this.plot_price
		
				const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
				expect(response.response.error).to.be.undefined
				expect(response.bounced).to.be.false
				expect(response.response_unit).to.be.validUnit
				expect(response.response.responseVars.message).to.eq("Left plot")
				
				const { vars: city_vars } = await this.bob.readAAStateVars(this.city_aa)
				expect(city_vars['plot_' + last_vacated_plot_num]).to.be.undefined
				expect(city_vars['user_land_' + this.bobAddress]).to.eq(bob_land)
				expect(city_vars['user_land_city_' + this.bobAddress]).to.eq(bob_land)
		
				expect(city_vars.city_city).to.deep.eq({
					count_plots: count_plots,
					count_houses: 0,
					total_land: total_land,
					total_bought: this.plot_price * plot_num,
					total_rented: 0,
					start_ts: this.start_ts,
					mayor: this.founderAddress,
				})
				expect(city_vars.state).to.deep.eq({
					last_house_num: 0,
					last_plot_num: plot_num,
					total_land: total_land,
				})
			}
		}

		// alice sends build request
		const { unit: alice_unit, error: alice_error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				build: 1,
				plot1_num: 1,
				plot2_num: plot_num,
			},
		})
		expect(alice_error).to.be.null
		expect(alice_unit).to.be.validUnit

		const { response: alice_response } = await this.network.getAaResponseToUnitOnNode(this.alice, alice_unit)
		expect(alice_response.response.error).to.be.undefined
		expect(alice_response.bounced).to.be.false
		expect(alice_response.response_unit).to.be.null
		expect(alice_response.response.responseVars.message).to.eq("Registered your request. Your neighbor must send their request within 10 minutes, otherwise you both will have to start over.")

		const { vars: alice_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(alice_vars['match_1_' + plot_num]).to.deep.eq({
			first: this.aliceAddress,
			ts: alice_response.timestamp
		})

		// bob sends build request
		const { unit: bob_unit, error: bob_error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				build: 1,
				plot1_num: 1,
				plot2_num: plot_num,
			},
		})
		expect(bob_error).to.be.null
		expect(bob_unit).to.be.validUnit

		total_land += 2 * this.plot_price
		bob_land += this.plot_price
		const alice_land = 2 * this.plot_price
		count_plots += 2

		const { response: bob_response } = await this.network.getAaResponseToUnitOnNode(this.bob, bob_unit)
		expect(bob_response.response.error).to.be.undefined
		expect(bob_response.bounced).to.be.false
		expect(bob_response.response_unit).to.be.null
		expect(bob_response.response.responseVars.message).to.eq("Now you've built a house on your land and will receive two new plots of land. Please wait a few minutes for the plots to be randomly allocated.")

		const { vars: bob_vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(bob_vars['match_1_' + plot_num]).to.deep.eq({
			first: this.aliceAddress,
			ts: alice_response.timestamp,
			built_ts: bob_response.timestamp,
		})
		expect(bob_vars['house_1']).to.deep.eq({
			plot_num: 1,
			owner: this.aliceAddress,
			amount: this.plot_price,
			city: 'city',
			x: this.plot1.x,
			y: this.plot1.y,
			ts: bob_response.timestamp,
			plot_ts: this.plot1.ts,
			info: false,
		})
		expect(bob_vars['house_2']).to.deep.eq({
			plot_num: plot_num,
			owner: this.bobAddress,
			amount: this.plot_price,
			city: 'city',
			x: bob_plot.x,
			y: bob_plot.y,
			ts: bob_response.timestamp,
			plot_ts: bob_plot.ts,
			info: false,
		})
		expect(bob_vars.state).to.deep.eq({
			last_house_num: 2,
			last_plot_num: plot_num + 4,
			total_land: total_land,
		})
		expect(bob_vars.city_city).to.deep.eq({
			count_plots: count_plots,
			count_houses: 2,
			total_land: total_land,
			total_bought: this.plot_price * plot_num,
			total_rented: 0,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})
		expect(bob_vars['plot_1']).to.be.undefined
		expect(bob_vars['plot_' + plot_num]).to.be.undefined
		expect(bob_vars['user_land_' + this.bobAddress]).to.eq(bob_land)
		expect(bob_vars['user_land_city_' + this.bobAddress]).to.eq(bob_land)
		expect(bob_vars['user_land_' + this.aliceAddress]).to.eq(alice_land)
		expect(bob_vars['user_land_city_' + this.aliceAddress]).to.eq(alice_land)
		expect(bob_vars['user_houses_' + this.bobAddress]).to.eq(1)
		expect(bob_vars['user_houses_city_' + this.bobAddress]).to.eq(1)
		expect(bob_vars['user_houses_' + this.aliceAddress]).to.eq(1)
		expect(bob_vars['user_houses_city_' + this.aliceAddress]).to.eq(1)

		// generate coordinates for the 4 new plots
		for (let i = plot_num + 1; i <= plot_num + 4; i++) {
			const { unit } = await this.generateRandomness(i)
			await this.network.witnessUntilStable(unit) // to avoid high tps fees from unexecuted trigger
		}

		this.plot_num = plot_num + 4
		this.count_plots = count_plots
		this.total_land = total_land
		this.alice_land = alice_land
		this.bob_land = bob_land
		this.total_bought = this.plot_price * plot_num

	})


	it("Withdraw random oracle's earnings to the randomness AA", async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				withdraw_rand_provider_earnings: 1,
				randomness_aa: this.randomness_aa_address,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['rand_provider_balance_' + this.randomness_aa_address]).to.eq(0)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.randomness_aa_address,
				amount: this.random_oracle_earnings,
			},
		])

		const bal = await this.alice.getOutputsBalanceOf(this.randomness_aa_address)
		expect(bal[this.asset].total).to.eq(this.random_oracle_earnings)

	})


	it("Withdraw random oracle's earnings from the randomness AA to the oracle's address", async () => {
		const bal_before = await this.alice.getOutputsBalanceOf(this.randomness_aa_address)
		expect(bal_before[this.asset].total).to.eq(this.random_oracle_earnings)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.randomness_aa_address,
			amount: 10000,
			data: {
				withdraw: 1,
				asset: this.asset,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.vrfOracleAddress,
				amount: this.random_oracle_earnings,
			},
		])

		const bal_after = await this.alice.getOutputsBalanceOf(this.randomness_aa_address)
		expect(bal_after[this.asset]).to.be.undefined

		const oracle_bal = await this.vrfOracle.getBalance()
		expect(oracle_bal[this.asset].total).to.eq(this.random_oracle_earnings)

		this.random_oracle_earnings = 0
	})


	it("Withdraw bounce fees from the randomness AA to the oracle's address", async () => {
		const { unit, error } = await this.vrfOracle.triggerAaWithData({
			toAddress: this.randomness_aa_address,
			amount: 10000,
			data: {
				withdraw_bounce_fees: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.vrfOracle, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.vrfOracle.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.vrfOracleAddress,
				amount: this.bounce_fees * 0.8,
			},
		])

		const { vars: rand_vars } = await this.vrfOracle.readAAStateVars(this.randomness_aa_address)
		expect(rand_vars['bounce_fees_' + this.vrfOracleAddress]).to.eq(0)
		expect(rand_vars['total_bounce_fees']).to.eq(0)

		this.bounce_fees = 0
	})


	it('Alice leaves one of the plots she has just won', async () => {
		const plot_num = this.plot_num - 3 // out of the last 4 plots, the first 2 belong to Alice
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				leave: 1,
				plot_num: plot_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.total_land -= this.plot_price
		this.count_plots--
		this.alice_land -= this.plot_price

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Left plot")
		
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: this.plot_price,
			},
			{
				address: this.governance_aa,
				amount: 1000,
			},
		])

		const { vars: city_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(city_vars['plot_' + plot_num]).to.be.undefined
		expect(city_vars['user_land_' + this.aliceAddress]).to.eq(this.alice_land)
		expect(city_vars['user_land_city_' + this.aliceAddress]).to.eq(this.alice_land)

		expect(city_vars.city_city).to.deep.eq({
			count_plots: this.count_plots,
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: 0,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})
		expect(city_vars.state).to.deep.eq({
			last_house_num: 2,
			last_plot_num: this.plot_num,
			total_land: this.total_land,
		})
	})


	it("Launch the CITY token and try to buy with Bytes", async () => {
		const afterLaunchDate = new Date(this.launchDate)
		afterLaunchDate.setDate(afterLaunchDate.getDate() + 1) // add 1 day
		await this.timetravelToDate(afterLaunchDate.toISOString().slice(0, 10))

		const bytes_amount = this.getAmountToBuy(true)
		const city_amount = this.getAmountToBuy(false)
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: bytes_amount,
			data: {
				buy: 1
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
		expect(response.response.error).to.eq("neither case is true in messages")

	})


	it('Bob buys land for CITY', async () => {
		const amount = this.getAmountToBuy(false)
		console.log(`paying ${amount/1e9} CITY`)

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: amount }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
					ref: this.aliceAddress,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.plot_num++
		this.count_plots++
		this.total_land += this.plot_price
		this.total_bought += this.plot_price
		this.bob_land += this.plot_price

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.plot_num).to.eq(this.plot_num)
		expect(response.response.responseVars.warning).to.eq("The referring user has no main plot")

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['user_land_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['user_land_city_' + this.bobAddress]).eq(this.bob_land)
		expect(vars.city_city).to.deep.eq({
			count_plots: this.count_plots,
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: 0,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})
		expect(vars['plot_' + this.plot_num]).to.deep.eq({
			status: 'pending',
			amount: this.plot_price,
			city: 'city',
			ts: response.timestamp,
			owner: this.bobAddress,
			username: 'bob',
			ref: this.aliceAddress,
		})

		await this.generateRandomness(this.plot_num)
	})


	it("Bob tries to transfer a plot to the VRF oracle, who is not attested", async () => {
		const plot_num = this.plot_num - 2
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				transfer: 1,
				plot_num,
				to: this.vrfOracleAddress,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.eq("new owner's address must be attested")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})


	it("Bob transfers a plot to Alice", async () => {
		const plot_num = this.plot_num - 2
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				transfer: 1,
				plot_num,
				to: this.aliceAddress,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.alice_land += this.plot_price
		this.bob_land -= this.plot_price

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Transferred")

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['user_land_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['user_land_city_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['user_land_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['user_land_city_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['plot_' + plot_num].owner).eq(this.aliceAddress)
		expect(vars['plot_' + plot_num].username).eq('alice')
		expect(vars['plot_' + plot_num].last_transfer_ts).eq(response.timestamp)

	})


	it("Bob puts a plot on sale", async () => {
		const plot_num = this.plot_num - 1
		const sale_price = 1010e9
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				sell: 1,
				plot_num,
				sale_price,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Put on sale")

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['plot_' + plot_num].owner).eq(this.bobAddress)
		expect(vars['plot_' + plot_num].sale_price).eq(sale_price)

	})


	it('Alice p2p buys the plot from Bob', async () => {
		const plot_num = this.plot_num - 1
		const amount = 1010e9

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: amount }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					p2p_buy: 1,
					plot_num,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.alice_land += this.plot_price
		this.bob_land -= this.plot_price

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Bought")

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: amount * 0.99,
			},
			{
				address: this.governance_aa,
				amount: 1000,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['user_land_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['user_land_city_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['user_land_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['user_land_city_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['plot_' + plot_num].owner).eq(this.aliceAddress)
		expect(vars['plot_' + plot_num].username).eq('alice')
		expect(vars['plot_' + plot_num].last_transfer_ts).eq(response.timestamp)
		expect(vars['plot_' + plot_num].sale_price).to.be.undefined

	})


	it('Bob rents', async () => {
		const plot_num = this.plot_num
		const rented_amount = 1 * this.plot_price

		const year = 365 * 24 * 3600
		const ts = Math.round(await this.timetravel('0s') / 1000)
		const elapsed = ts - this.start_ts
		const buys_per_year = year / elapsed * (this.plot_num - 4)
		const income_per_buy = 2 * this.plot_price * this.matching_probability * rented_amount / (this.total_land + rented_amount)
		const rental_fee = Math.ceil(buys_per_year * income_per_buy)
		console.log('rental fee', rental_fee, `=${rental_fee/this.plot_price} plots`)
		const excess = 100

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: rental_fee + excess }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					rent: 1,
					plot_num,
					rented_amount,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Rented")

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		const payments = Utils.getExternalPayments(unitObj)
		console.log(payments)
		expect(payments.length).to.eq(1)
		expect(payments[0].asset).to.eq(this.asset)
		expect(payments[0].address).to.eq(this.bobAddress)
		expect(payments[0].amount).to.be.closeTo(excess, 1)

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['plot_' + plot_num].rented_amount).eq(rented_amount)
		expect(vars['plot_' + plot_num].rental_expiry_ts).eq(ts + year)
		expect(vars.city_city).to.deep.eq({
			count_plots: this.count_plots,
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: rented_amount,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})

		this.total_rented = rented_amount

		// plot_num - 3 is Alices's 2nd reward plot
		const bNeighbors = await this.are_neighbors(plot_num - 3, plot_num)
		console.log(`plots ${plot_num - 3} and ${plot_num} are neighbors? ${bNeighbors}`);

	})


	it("Bob immediately rents the same area again and doesn't pay anything", async () => {
		const plot_num = this.plot_num
		const rented_amount = 1 * this.plot_price

		const year = 365 * 24 * 3600
		const ts = Math.round(await this.timetravel('0s') / 1000)
		const elapsed = ts - this.start_ts
		const buys_per_year = year / elapsed * (this.plot_num - 4)
		const income_per_buy = 2 * this.plot_price * this.matching_probability * rented_amount / (this.total_land + rented_amount)
		const rental_fee = 0//Math.ceil(buys_per_year * income_per_buy)
		console.log('rental fee', rental_fee, `=${rental_fee/this.plot_price} plots`)
		const excess = 100

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: rental_fee + excess }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					rent: 1,
					plot_num,
					rented_amount,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Rented")

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		const payments = Utils.getExternalPayments(unitObj)
		console.log(payments)
		expect(payments.length).to.eq(1)
		expect(payments[0].asset).to.eq(this.asset)
		expect(payments[0].address).to.eq(this.bobAddress)
		expect(payments[0].amount).to.be.closeTo(excess, 1)

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['plot_' + plot_num].rented_amount).eq(rented_amount)
		expect(vars['plot_' + plot_num].rental_expiry_ts).eq(ts + year)
		expect(vars.city_city).to.deep.eq({
			count_plots: this.count_plots,
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: rented_amount,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})

		this.total_rented = rented_amount

		// plot_num - 3 is Alices's 2nd reward plot
		const bNeighbors = await this.are_neighbors(plot_num - 3, plot_num)
		console.log(`plots ${plot_num - 3} and ${plot_num} are neighbors? ${bNeighbors}`);

	})


	it('Bob rents the same area again after 10 days and pays for the additional 10 days', async () => {
		const plot_num = this.plot_num
		const rented_amount = 1 * this.plot_price

		const year = 365 * 24 * 3600
		const ts = Math.round(await this.timetravel('10d') / 1000)
		const elapsed = ts - this.start_ts
		const buys_per_year = year / elapsed * (this.plot_num - 4)
		const income_per_buy = 2 * this.plot_price * this.matching_probability * rented_amount / (this.total_land + rented_amount)
		const rental_fee = Math.ceil(buys_per_year * income_per_buy * 10 / 365)
		console.log('rental fee', rental_fee, `=${rental_fee/this.plot_price} plots`)
		const excess = 100

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: rental_fee + excess }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					rent: 1,
					plot_num,
					rented_amount,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Rented")

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		const payments = Utils.getExternalPayments(unitObj)
		console.log(payments)
		expect(payments.length).to.eq(1)
		expect(payments[0].asset).to.eq(this.asset)
		expect(payments[0].address).to.eq(this.bobAddress)
		expect(payments[0].amount).to.be.closeTo(excess, 1)

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['plot_' + plot_num].rented_amount).eq(rented_amount)
		expect(vars['plot_' + plot_num].rental_expiry_ts).eq(ts + year)
		expect(vars.city_city).to.deep.eq({
			count_plots: this.count_plots,
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: rented_amount,
			start_ts: this.start_ts,
			mayor: this.founderAddress
		})

		this.total_rented = rented_amount

		// plot_num - 3 is Alices's 2nd reward plot
		const bNeighbors = await this.are_neighbors(plot_num - 3, plot_num)
		console.log(`plots ${plot_num - 3} and ${plot_num} are neighbors? ${bNeighbors}`);

	})


	it("Withdraw the fundraise", async () => {
		const amount = (this.plot_num - 5) * this.plot_price / 1000
		const { unit, error } = await this.founder.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				withdraw_fundraise: 1,
				amount,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.founder, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.founder.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.founderAddress,
				amount,
			},
		])

	})


	it("Bob edits his user profile", async () => {
		const main_plot_num = this.plot_num
		const info = {name: 'Bob', twitter: '@bob', blog: 'https://....'}
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_user: 1,
				info,
				main_plot_num,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited user profile")

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['user_' + this.bobAddress]).deep.eq(info)
		expect(vars['user_main_plot_city_' + this.bobAddress]).eq(main_plot_num)
		this.bob_main_plot_num = main_plot_num
	})


	it("Bob edits his plot", async () => {
		const plot_num = this.plot_num
		const info = {name: "Bob's estate", twitter: '@bob', blog: 'https://....'}
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_plot: 1,
				info,
				plot_num,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited plot")

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['plot_' + plot_num].info).deep.eq(info)

	})


	it("Bob edits his house and tries to use an invalid shortcode", async () => {
		const house_num = 2
		const info = { name: "Bob's palace", twitter: '@bob', blog: 'https://....' }
		const shortcode = 'Bob'
		const shortcode_price = 1e9
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				info,
				shortcode,
				sell_shortcode: 1,
				shortcode_price,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.eq("shortcode is allowed to include only lowercase latin letters, numbers, -, _, and .")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})


	it("Bob edits his house", async () => {
		const house_num = 2
		const info = { name: "Bob's palace", twitter: '@bob', blog: 'https://....' }
		const shortcode = 'bob'
		const shortcode_price = 1e9
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				info,
				shortcode,
				sell_shortcode: 1,
				shortcode_price,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].info).deep.eq(info)
		expect(vars['house_' + house_num].shortcode).to.eq(shortcode)
		expect(vars['house_' + house_num].shortcode_price).to.eq(shortcode_price)
		expect(vars['shortcode_' + shortcode]).to.eq(this.bobAddress)

	})


	it("Alice edits her house", async () => {
		const house_num = 1
		const info = { name: "Alice's palace", twitter: '@alice', blog: 'https://....' }
		const shortcode = 'alice.in-wonderland'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				info,
				shortcode,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].info).deep.eq(info)
		expect(vars['house_' + house_num].shortcode).to.eq(shortcode)
		expect(vars['shortcode_' + shortcode]).to.eq(this.aliceAddress)

	})


	it("Alice edits her house and tries to use bob's shortcode", async () => {
		const house_num = 1
		const shortcode = 'bob'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				shortcode,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.eq("this shortcode is already taken")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})


	it("Alice edits her house and assigns a new shortcode", async () => {
		const house_num = 1
		const shortcode = 'alice2'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				shortcode,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].shortcode).to.eq(shortcode)
		expect(vars['shortcode_' + shortcode]).to.eq(this.aliceAddress)
		expect(vars['shortcode_alice']).to.be.undefined // old shortcode should be released

	})


	it("Alice edits her house and assigns a new shortcode to the attestor's address", async () => {
		const house_num = 1
		const shortcode = 'attestor'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				shortcode,
				to: this.attestorAddress,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].shortcode).to.eq(shortcode)
		expect(vars['shortcode_' + shortcode]).to.eq(this.attestorAddress)
		expect(vars['shortcode_alice2']).to.be.undefined // old shortcode should be released

	})


	it("Alice edits her house and releases the shortcode", async () => {
		const house_num = 1
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				release_shortcode: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].shortcode).to.eq('')
		expect(vars['shortcode_attestor']).to.be.undefined

	})


	it('Alice p2p buys a shortcode from Bob', async () => {
		const shortcode_price = 1e9

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: shortcode_price }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					p2p_buy_shortcode: 1,
					seller_house_num: 2,
					my_house_num: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Bought shortcode")

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: shortcode_price * 0.99,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_1'].shortcode).eq('bob')
		expect(vars['house_2'].shortcode).eq('')
		expect(vars['house_2'].shortcode_price).to.be.undefined

	})


	it("Alice edits her house and assigns the newly bought shortcode 'bob' to her own address", async () => {
		const house_num = 1
		const shortcode = 'bob'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				shortcode,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].shortcode).to.eq(shortcode)
		expect(vars['shortcode_' + shortcode]).to.eq(this.aliceAddress)

	})


	it("Claim follow-up reward", async () => {
		const reward = this.plot_price * 0.1
		const days = 60
		// move to 61 days after matching
		await this.timetravelToDate(new Date((this.start_ts + 61 * 24 * 3600) * 1000).toISOString().substring(0, 10))

		// alice sends followup request
		const { unit: alice_unit, error: alice_error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				followup: 1,
				days,
				house1_num: 1,
				house2_num: 2,
			},
		})
		expect(alice_error).to.be.null
		expect(alice_unit).to.be.validUnit

		const { response: alice_response } = await this.network.getAaResponseToUnitOnNode(this.alice, alice_unit)
		console.log(alice_response.response.error)
		expect(alice_response.response.error).to.be.undefined
		expect(alice_response.bounced).to.be.false
		expect(alice_response.response_unit).to.be.null
		expect(alice_response.response.responseVars.message).to.eq("Registered your request. Your neighbor must send their request within 10 minutes, otherwise you both will have to start over.")

		const { vars: alice_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(alice_vars['followup_1_2']).to.deep.eq({
			reward,
			[days]: {
				first: this.aliceAddress,
				ts: alice_response.timestamp
			}
		})

		// bob sends followup request
		const { unit: bob_unit, error: bob_error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				followup: 1,
				days,
				house1_num: 1,
				house2_num: 2,
			},
		})
		expect(bob_error).to.be.null
		expect(bob_unit).to.be.validUnit

		const { response: bob_response } = await this.network.getAaResponseToUnitOnNode(this.bob, bob_unit)
		expect(bob_response.response.error).to.be.undefined
		expect(bob_response.bounced).to.be.false
		expect(bob_response.response_unit).to.be.null
		expect(bob_response.response.responseVars.message).to.eq("Paid followup rewards")

		const { vars: bob_vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(bob_vars['followup_1_2']).to.deep.eq({
			reward,
			[days]: {
				first: this.aliceAddress,
				ts: alice_response.timestamp,
				paid_ts: bob_response.timestamp,
			}
		})
		expect(bob_vars['balance_' + this.aliceAddress]).to.eq(reward)
		expect(bob_vars['balance_' + this.bobAddress]).to.eq(reward)
		this.alice_balance = reward
		this.bob_balance = reward
	})

	
	it('Attest the founder/mayor', async () => {
		const { unit, error } = await this.attestor.sendMulti({
			messages: [{
				app: 'attestation',
				payload: {
					address: this.founderAddress,
					profile: {
						username: 'tonych',
					},
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Mayor creates a new house', async () => {
		const amount = this.getAmountToBuy(true)
		console.log(`paying ${amount/1e9} GB`)

		const { unit, error } = await this.founder.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				buy: 1,
				mayor_plot: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.plot_num++

		const { response } = await this.network.getAaResponseToUnitOnNode(this.founder, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.plot_num).to.eq(this.plot_num)

		const { vars } = await this.founder.readAAStateVars(this.city_aa)
		expect(vars.state).to.deep.eq({
			last_house_num: 2,
			last_plot_num: this.plot_num,
			total_land: this.total_land,
		})
		expect(vars.city_city).to.deep.eq({ // unchanged
			count_plots: this.count_plots, // real plots only
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: this.total_rented,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})
		expect(vars['plot_' + this.plot_num]).to.deep.eq({
			status: 'pending',
			amount: 0,
			city: 'city',
			ts: response.timestamp,
		})

		const { unit: rand_unit } = await this.generateRandomness(this.plot_num)
		await this.network.witnessUntilStable(rand_unit)

		const { vars: rand_vars } = await this.founder.readAAStateVars(this.city_aa)
		expect(rand_vars.state).to.deep.eq({
			last_house_num: 4,
			last_plot_num: this.plot_num,
			total_land: this.total_land,
		})
		expect(rand_vars.city_city).to.deep.eq({ // unchanged
			count_plots: this.count_plots,
			count_houses: 2, // real houses only
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: this.total_rented,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})
		expect(rand_vars['plot_' + this.plot_num]).to.be.undefined
		expect(rand_vars.house_3).to.be.undefined
		expect(rand_vars.house_4.plot_num).to.eq(this.plot_num)
		expect(rand_vars.house_4.owner).to.be.undefined
		expect(rand_vars.house_4.amount).to.eq(0)
		expect(rand_vars.house_4.plot_ts).to.eq(response.timestamp)
		expect(rand_vars.house_4.info).to.eq(false)
		expect(rand_vars.house_4.city).to.eq('city')
		expect(rand_vars.house_4.x).to.gte(0)
		expect(rand_vars.house_4.y).to.gte(0)
	})


	it("Mayor edits Satoshi's house", async () => {
		const house_num = 4
		const info = { name: "Satoshi's palace", twitter: '@satoshi', blog: 'https://....' }
		const { unit, error } = await this.founder.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				info,
				new_owner: this.aliceAddress,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.founder, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.founder.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].info).deep.eq(info)
		expect(vars['house_' + house_num].owner).to.eq(this.aliceAddress)

	})


	it("Alice edits Satoshi's house", async () => {
		const house_num = 4
		const info = { name: "Satoshi's palace managed by Alice", twitter: '@satoshi', blog: 'https://....' }
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				info,
				new_owner: this.aliceAddress,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].info).deep.eq(info)
		expect(vars['house_' + house_num].owner).to.eq(this.aliceAddress)

	})


	it("Alice votes for changing the plot price", async () => {
		const name = 'plot_price'
		const value = 50e9
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				value,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars['support_' + name + '_' + value]).to.eq(this.alice_land)
		expect(vars['leader_' + name]).to.eq(value)
		expect(vars['challenging_period_start_ts_' + name]).to.eq(response.timestamp)
		expect(vars['choice_' + this.aliceAddress + '_' + name]).to.eq(value)
		expect(vars['votes_' + this.aliceAddress]).deep.eq({
			plot_price: {
				value,
				balance: this.alice_land,
			}
		})

	})


	it("Alice commits the new plot price", async () => {
		await this.timetravel('4d')
		const name = 'plot_price'
		const value = 50e9
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				commit: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars[name]).to.eq(value)

		const { vars: city_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(city_vars.variables[name]).to.eq(value)
		this.plot_price = value

	})


	it('Bob buys land from balance', async () => {
		const amount = this.getAmountToBuy(false)
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				buy: 1,
				buy_from_balance: 1,
				ref: this.aliceAddress, // must be ignored
			}
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.plot_num++
		this.count_plots++
		this.total_land += this.plot_price
		this.total_bought += this.plot_price
		this.bob_land += this.plot_price
		this.bob_balance -= amount

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.plot_num).to.eq(this.plot_num)
		expect(response.response.responseVars.warning).to.be.undefined

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['user_land_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['user_land_city_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['balance_' + this.bobAddress]).eq(this.bob_balance)
		expect(vars.city_city).to.deep.eq({
			count_plots: this.count_plots,
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: this.total_rented,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
		})
		expect(vars['plot_' + this.plot_num]).to.deep.eq({
			status: 'pending',
			amount: this.plot_price,
			city: 'city',
			ts: response.timestamp,
			owner: this.bobAddress,
			username: 'bob',
		//	ref: this.aliceAddress,
		})

		await this.generateRandomness(this.plot_num)
	})


	it("Bob votes for changing the plot price in the city 'city'", async () => {
		const city = 'city'
		const name = 'plot_price'
		const value = 40e9
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				value,
				city,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const full_name = name + '|' + city

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.bob.readAAStateVars(this.governance_aa)
		expect(vars['support_' + full_name + '_' + value]).to.eq(this.bob_land)
		expect(vars['leader_' + full_name]).to.eq(value)
		expect(vars['challenging_period_start_ts_' + full_name]).to.eq(response.timestamp)
		expect(vars['choice_' + this.bobAddress + '_' + full_name]).to.eq(value)
		expect(vars['votes_' + this.bobAddress]).deep.eq({
			[full_name]: {
				value,
				balance: this.bob_land,
			}
		})

	})


	it("Alice commits the new plot price for city 'city'", async () => {
		await this.timetravel('4d')
		const city = 'city'
		const name = 'plot_price'
		const value = 40e9
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				city,
				commit: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const full_name = name + '|' + city

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars[full_name]).to.eq(value)
		expect(vars[name]).to.eq(this.plot_price)

		const { vars: city_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(city_vars.variables[name]).to.eq(this.plot_price)
		expect(city_vars.city_city[name]).to.eq(value)
		this.plot_price = value

	})


	it('Alice buys land with referral', async () => {
		const amount = this.getAmountToBuy(false)
		console.log(`paying ${amount/1e9} CITY`)

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: amount }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
					ref: this.bobAddress,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.plot_num++
		this.count_plots++
		this.total_land += this.plot_price
		this.total_bought += this.plot_price
		this.alice_land += this.plot_price

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.plot_num).to.eq(this.plot_num)
		expect(response.response.responseVars.warning).to.be.undefined

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['user_land_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['user_land_city_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['balance_' + this.aliceAddress]).eq(this.alice_balance)
		expect(vars.city_city).to.deep.eq({
			count_plots: this.count_plots,
			count_houses: 2,
			total_land: this.total_land,
			total_bought: this.total_bought,
			total_rented: this.total_rented,
			start_ts: this.start_ts,
			mayor: this.founderAddress,
			plot_price: this.plot_price,
		})
		expect(vars['plot_' + this.plot_num]).to.deep.eq({
			status: 'pending',
			amount: this.plot_price,
			city: 'city',
			ts: response.timestamp,
			owner: this.aliceAddress,
			username: 'alice',
			ref: this.bobAddress,
			ref_plot_num: this.bob_main_plot_num
		})

		await this.generateRandomness(this.plot_num)
	})


	it("Bob votes for creating a new city named 'şehir'", async () => {
		const city = 'şehir'
	//	const city = '城市'
		const name = 'new_city'
		const mayor = this.aliceAddress
		const value = 'yes'
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				value,
				city,
				mayor,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const full_name = name + '|' + city + '|' + mayor

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.bob.readAAStateVars(this.governance_aa)
		expect(vars['support_' + full_name + '_' + value]).to.eq(this.bob_land)
		expect(vars['leader_' + full_name]).to.eq(value)
		expect(vars['challenging_period_start_ts_' + full_name]).to.eq(response.timestamp)
		expect(vars['choice_' + this.bobAddress + '_' + full_name]).to.eq(value)
		expect(vars['votes_' + this.bobAddress]).deep.eq({
			[full_name]: {
				value,
				balance: this.bob_land,
			},
			'plot_price|city': {
				value: 40e9,
				balance: this.bob_land,
			},
		})
		this.challenging_period_start_ts = response.timestamp

	})


	it("Alice also votes for creating a new city named 'şehir'", async () => {
		const city = 'şehir'
	//	const city = '城市'
		const name = 'new_city'
		const mayor = this.aliceAddress
		const value = 'yes'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				value,
				city,
				mayor,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const full_name = name + '|' + city + '|' + mayor

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars['support_' + full_name + '_' + value]).to.eq(this.alice_land + this.bob_land)
		expect(vars['leader_' + full_name]).to.eq(value)
		expect(vars['challenging_period_start_ts_' + full_name]).to.eq(this.challenging_period_start_ts)
		expect(vars['choice_' + this.aliceAddress + '_' + full_name]).to.eq(value)
		expect(vars['votes_' + this.aliceAddress]).deep.eq({
			[full_name]: {
				value,
				balance: this.alice_land,
			},
			'plot_price': {
				value: 50e9,
				balance: this.alice_land - this.plot_price, // earlier balance
			},
		})

	})


	it("Alice commits creation of the new city named 'şehir'", async () => {
		await this.timetravel('4d')
		const city = 'şehir'
	//	const city = '城市'
		const name = 'new_city'
		const mayor = this.aliceAddress
		const value = 'yes'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				city,
				mayor,
				commit: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const full_name = name + '|' + city + '|' + mayor

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars[full_name]).to.eq(value)

		const { vars: city_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(city_vars['city_' + city]).to.deep.eq({
			count_plots: 0,
			count_houses: 0,
			total_land: 0,
			total_bought: 0,
			total_rented: 0,
			start_ts: 0,
			mayor,
		})

	})


	it('Bob buys land in şehir for Alice', async () => {
		const city = 'şehir'
		this.plot_price = 50e9 // global price
		const amount = this.getAmountToBuy(false)
		console.log(`paying ${amount/1e9} CITY`)

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.city_aa, amount: amount }],
				base: [{ address: this.city_aa, amount: 10000 }],
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
					ref: this.bobAddress,
					city,
					to: this.aliceAddress, // Alice will be the owner
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.plot_num++
		this.count_plots++
		this.total_land += this.plot_price
		this.total_bought += this.plot_price
		this.alice_land += this.plot_price

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.plot_num).to.eq(this.plot_num)
		expect(response.response.responseVars.warning).to.eq("The referring user has no main plot")

		const { vars } = await this.bob.readAAStateVars(this.city_aa)
		expect(vars['user_land_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['user_land_city_' + this.aliceAddress]).eq(this.alice_land - this.plot_price) // unchanged
		expect(vars['user_land_' + city + '_' + this.aliceAddress]).eq(this.plot_price)
		expect(vars['balance_' + this.aliceAddress]).eq(this.alice_balance)
		expect(vars['city_' + city]).to.deep.eq({
			count_plots: 1,
			count_houses: 0,
			total_land: this.plot_price,
			total_bought: this.plot_price,
			total_rented: 0,
			start_ts: response.timestamp,
			mayor: this.aliceAddress,
		})
		expect(vars['plot_' + this.plot_num]).to.deep.eq({
			status: 'pending',
			amount: this.plot_price,
			city,
			ts: response.timestamp,
			owner: this.aliceAddress,
			username: 'alice',
			ref: this.bobAddress,
		})

		this.city2_start_ts = response.timestamp

		await this.generateRandomness(this.plot_num)
	})


	it('Alice creates a new house in şehir as mayor', async () => {
		const city = 'şehir'
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				buy: 1,
				mayor_plot: 1,
				city,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.plot_num++

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.plot_num).to.eq(this.plot_num)

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars.state).to.deep.eq({
			last_house_num: 4,
			last_plot_num: this.plot_num,
			total_land: this.total_land,
		})
		expect(vars['city_' + city]).to.deep.eq({ // unchanged
			count_plots: 1, // real plots only
			count_houses: 0,
			total_land: this.plot_price,
			total_bought: this.plot_price,
			total_rented: 0,
			start_ts: this.city2_start_ts,
			mayor: this.aliceAddress,
		})
		expect(vars['plot_' + this.plot_num]).to.deep.eq({
			status: 'pending',
			amount: 0,
			city,
			ts: response.timestamp,
		})

		const { unit: rand_unit } = await this.generateRandomness(this.plot_num)
		await this.network.witnessUntilStable(rand_unit)

		const { vars: rand_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(rand_vars.state).to.deep.eq({
			last_house_num: 6,
			last_plot_num: this.plot_num,
			total_land: this.total_land,
		})
		expect(rand_vars['city_' + city]).to.deep.eq({ // unchanged
			count_plots: 1,
			count_houses: 0, // real houses only
			total_land: this.plot_price,
			total_bought: this.plot_price,
			total_rented: 0,
			start_ts: this.city2_start_ts,
			mayor: this.aliceAddress,
		})
		expect(rand_vars['plot_' + this.plot_num]).to.be.undefined
		expect(rand_vars.house_5).to.be.undefined
		expect(rand_vars.house_6.plot_num).to.eq(this.plot_num)
		expect(rand_vars.house_6.owner).to.be.undefined
		expect(rand_vars.house_6.amount).to.eq(0)
		expect(rand_vars.house_6.plot_ts).to.eq(response.timestamp)
		expect(rand_vars.house_6.info).to.eq(false)
		expect(rand_vars.house_6.city).to.eq(city)
		expect(rand_vars.house_6.x).to.gte(0)
		expect(rand_vars.house_6.y).to.gte(0)
	})


	it("Mayor Alice edits Lewis Caroll's house in şehir", async () => {
		const house_num = 6
		const info = { name: "Lewis Caroll's palace", twitter: '@lewisc', blog: 'https://....' }
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				edit_house: 1,
				house_num,
				info,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.eq("Edited house")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['house_' + house_num].info).deep.eq(info)
		expect(vars['house_' + house_num].owner).to.be.undefined

	})


	it("Alice votes for making Bob mayor of city 'şehir'", async () => {
		const city = 'şehir'
		const name = 'mayor'
		const value = this.bobAddress
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				value,
				city,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const full_name = name + '|' + city

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars['support_' + full_name + '_' + value]).to.eq(this.plot_price)
		expect(vars['leader_' + full_name]).to.eq(value)
		expect(vars['challenging_period_start_ts_' + full_name]).to.eq(response.timestamp)
		expect(vars['choice_' + this.aliceAddress + '_' + full_name]).to.eq(value)
		expect(vars['votes_' + this.aliceAddress]).deep.eq({
			[full_name]: {
				value,
				balance: this.plot_price,
			},
			[`new_city|${city}|${this.aliceAddress}`]: {
				value: 'yes',
				balance: this.alice_land - this.plot_price, // earlier balance
			},
			'plot_price': {
				value: 50e9,
				balance: this.alice_land - 50e9 - 40e9, // even earlier balance
			},
		})

	})


	it("Alice commits the new mayor for city 'şehir'", async () => {
		await this.timetravel('4d')
		const city = 'şehir'
		const name = 'mayor'
		const value = this.bobAddress
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 10000,
			data: {
				name,
				city,
				commit: 1,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const full_name = name + '|' + city

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(vars[full_name]).to.eq(value)

		const { vars: city_vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(city_vars['city_' + city]).to.deep.eq({
			count_plots: 1,
			count_houses: 0,
			total_land: this.plot_price,
			total_bought: this.plot_price,
			total_rented: 0,
			start_ts: this.city2_start_ts,
			mayor: this.bobAddress,
		})

	})


	it("Alice transfers her plot in şehir to Bob", async () => {
		const city = 'şehir'
		const plot_num = this.plot_num - 1 // the last was a mayor plot
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.city_aa,
			amount: 10000,
			data: {
				transfer: 1,
				plot_num,
				to: this.bobAddress,
			},
		})
		console.log({error, unit})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.alice_land -= this.plot_price
		this.bob_land += this.plot_price

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.eq("Transferred")

		const { vars } = await this.alice.readAAStateVars(this.city_aa)
		expect(vars['user_land_' + this.aliceAddress]).eq(this.alice_land)
		expect(vars['user_land_' + city + '_' + this.aliceAddress]).eq(0)
		expect(vars['user_land_' + this.bobAddress]).eq(this.bob_land)
		expect(vars['user_land_' + city + '_' + this.bobAddress]).eq(this.plot_price)
		expect(vars['plot_' + plot_num].owner).eq(this.bobAddress)
		expect(vars['plot_' + plot_num].last_transfer_ts).eq(response.timestamp)

		const { vars: gov_vars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gov_vars['support_mayor|' + city + '_' + this.bobAddress]).to.eq(0)
		expect(gov_vars['support_new_city|' + city + '|' + this.aliceAddress + '_yes']).to.eq((this.bob_land - this.plot_price) + this.alice_land) // previous bob's land plus new alice's land
		expect(gov_vars['support_plot_price_' + 50e9]).to.eq(this.alice_land)
		expect(gov_vars['votes_' + this.aliceAddress]).deep.eq({
			[`mayor|${city}`]: {
				value: this.bobAddress,
				balance: 0,
			},
			[`new_city|${city}|${this.aliceAddress}`]: {
				value: 'yes',
				balance: this.alice_land,
			},
			'plot_price': {
				value: 50e9,
				balance: this.alice_land,
			},
		})

	})


	after(async () => {
		await this.network.stop()
	})
})
