const assert = require('assert')
const BigNumber = require('bignumber.js')

const { timeTravel } = require('helpers')
const { gasPrice } = require('../helpers/general')
const {
  broker,
  custodian,
  defaultActivationTimeout,
  defaultFiatCurrency,
  defaultFiatCurrency32,
  defaultFiatRate,
  defaultPenalizedFiatRate,
  defaultFundingGoal,
  defaultFundingTimeout,
  defaultIpfsHashArray32,
  defaultName,
  defaultName32,
  defaultSymbol,
  defaultSymbol32,
  defaultTotalSupply,
  determineNeededTimeTravel,
  getDefaultStartTime,
  stages,
  testActivate,
  testBrokerClaim,
  testBuyRemainingTokens,
  testPayActivationFee,
  testStartEthSale,
  testUpdateProofOfCustody,
  whitelistedPoaBuyers
} = require('./poa')
const {
  getAllSequentialStorage,
  bytes32StorageToAscii,
  getMappingStorage,
  getNestedMappingStorage,
  trimRightBytes
} = require('./storage')

const checkPreInitializedStorage = async (poa, reg) => {
  const storage = await getAllSequentialStorage(poa.address)
  const poaTokenMaster = await reg.getContractAddress('PoaTokenMaster')
  const poaCrowdsaleMaster = await reg.getContractAddress('PoaCrowdsaleMaster')
  assert.equal(
    storage[0].data,
    poaTokenMaster,
    'poaTokenMaster should have the correct value at the correct slot'
  )
  assert.equal(
    storage[1].data,
    poaCrowdsaleMaster,
    'poaCrowdsaleMaster should have the correct value at the correct slot'
  )
  assert.equal(
    storage[2].data,
    reg.address,
    'registry address should have the correct value at the correct slot'
  )
}

const parseProxyCommonStorage = (storage, stageInitialized) => ({
  poaTokenMaster: storage[0].data,
  poaCrowdsaleMaster: storage[1].data,
  registry: stageInitialized ? '0x' + storage[2].data.slice(4) : storage[2].data
})

const parseCommonStorage = (storage, stageInitialized) => ({
  stage: stageInitialized
    ? new BigNumber(storage[2].data.slice(0, 4))
    : new BigNumber(0),
  actualBroker: storage[3].data,
  actualCustodian: storage[4].data,
  proofOfCustody32: [
    trimRightBytes(storage[5].data),
    trimRightBytes(storage[6].data)
  ],
  commonTotalSupply: new BigNumber(storage[7].data),
  fundedFiatAmountInTokens: new BigNumber(storage[8].data),
  fundedFiatAmountPerUserInTokens: storage[9].data,
  fundedEthAmountInWei: new BigNumber(storage[10].data),
  fundedEthAmountPerUserInWei: storage[11].data,
  unclaimedPayoutTotals: storage[12].data,
  crowdsaleInitialized: new BigNumber(storage[13].data.slice(0, 4)).toNumber(),
  isActivationFeePaid: new BigNumber(storage[13].data.slice(4, 6)).toNumber(),
  tokenInitialized: new BigNumber(
    '0x' + storage[13].data.slice(6, 8)
  ).toNumber(),
  paused: new BigNumber('0x' + storage[13].data.slice(8, 10)).toNumber(),
  startTimeForEthFundingPeriod: new BigNumber(storage[14].data),
  durationForEthFundingPeriod: new BigNumber(storage[15].data),
  durationForActivationPeriod: new BigNumber(storage[16].data),
  actualFiatCurrency32: bytes32StorageToAscii(storage[17].data),
  fundingGoalInCents: new BigNumber(storage[18].data),
  fundedFiatAmountInCents: new BigNumber(storage[19].data)
})

const parseTokenStorage = storage => ({
  name: bytes32StorageToAscii(storage[20].data),
  symbol: bytes32StorageToAscii(storage[21].data),
  totalPerTokenPayout: storage[22].data,
  actualOwner: storage[23].data,
  claimedPerTokenPayouts: storage[24].data,
  spentBalances: storage[25].data,
  receivedBalances: storage[26].data,
  allowed: storage[27].data,
  whitelistTransfers: storage[28].data
})

const initializeContract = async (poa, reg) => {
  await poa.initializeToken(
    defaultName32,
    defaultSymbol32,
    broker,
    custodian,
    reg.address,
    defaultTotalSupply
  )

  await poa.initializeCrowdsale(
    defaultFiatCurrency32,
    await getDefaultStartTime(),
    defaultFundingTimeout,
    defaultActivationTimeout,
    defaultFundingGoal
  )
}

const checkPostInitializedStorage = async (poa, reg, pmr) => {
  // get all storage
  const storage = await getAllSequentialStorage(poa.address)
  // proxy storage
  const {
    poaCrowdsaleMaster,
    poaTokenMaster,
    registry
  } = parseProxyCommonStorage(storage, false)
  // common storage
  const {
    actualBroker,
    actualCustodian,
    actualFiatCurrency32,
    commonTotalSupply,
    crowdsaleInitialized,
    durationForActivationPeriod,
    durationForEthFundingPeriod,
    fundedEthAmountInWei,
    fundedFiatAmountInCents,
    fundedFiatAmountInTokens,
    fundingGoalInCents,
    paused,
    proofOfCustody32,
    stage,
    startTimeForEthFundingPeriod,
    tokenInitialized
  } = parseCommonStorage(storage, false)

  // token storage
  const { allowed, actualOwner, name, symbol } = parseTokenStorage(storage)

  // get real master copy addresses from registry
  const actualTokenMaster = await reg.getContractAddress('PoaTokenMaster')
  const actualCrowdsaleMaster = await reg.getContractAddress(
    'PoaCrowdsaleMaster'
  )

  assert.equal(
    stage.toString(),
    stages.PreFunding,
    'stage should be in PreFunding stage'
  )
  assert.equal(
    actualCustodian,
    custodian,
    'custodian should match correct address'
  )
  assert.deepEqual(
    proofOfCustody32,
    ['0x', '0x'],
    'proofOfCustody32 should be empty'
  )
  assert.equal(
    commonTotalSupply.toString(),
    defaultTotalSupply.toString(),
    'commonTotalSupply should match defaultTotalSupply'
  )
  assert.equal(
    fundedFiatAmountInTokens.toString(),
    '0',
    'fundedFiatAmountInTokens should be 0'
  )
  assert.equal(
    fundedEthAmountInWei.toString(),
    '0',
    'fundedEthAmountInWei should be 0'
  )
  assert.equal(registry, reg.address, 'registry should match reg.address')
  assert(paused, 'paused should be true')
  assert(tokenInitialized, 'tokenInitialized should be true')
  assert.equal(
    poaTokenMaster,
    actualTokenMaster,
    'poaTokenMaster should match actualTokenMaster'
  )
  assert.equal(
    poaCrowdsaleMaster,
    actualCrowdsaleMaster,
    'poaCrowdsaleMaster should match actualCrowdsaleMaster'
  )
  assert(crowdsaleInitialized, 'crowdsaleInitialized should be true')
  assert(
    startTimeForEthFundingPeriod.greaterThan(1530280851),
    'startTimeForEthFundingPeriod should be greater than 06/29/2018'
  )
  assert.equal(
    durationForEthFundingPeriod.toString(),
    defaultFundingTimeout.toString(),
    'durationForEthFundingPeriod should match defaultFundingTimeout'
  )
  assert(
    durationForActivationPeriod.greaterThan(durationForEthFundingPeriod),
    'durationForActivationPeriod should be greater than durationForEthFundingPeriod'
  )
  assert.equal(
    actualFiatCurrency32,
    defaultFiatCurrency,
    'actualFiatCurrency32 should conver to match fiatCurrency'
  )
  assert.equal(
    fundingGoalInCents.toString(),
    defaultFundingGoal.toString(),
    'fundingGoalInCents should match defaultFundingGoal'
  )
  assert.equal(
    fundedFiatAmountInCents.toString(),
    '0',
    'fundedFiatAmountInCents should be 0'
  )
  assert.equal(actualBroker, broker, 'actualBroker should match broker')

  assert.equal(allowed, '0x00', 'allowed slot should be empty')
  assert.equal(
    actualOwner,
    pmr.address,
    'owner should be in expected storage slot'
  )
  assert.equal(name, defaultName, 'name32 should be in correct storage slot')
  assert.equal(
    symbol,
    defaultSymbol,
    'sybmbol32 should be in correct storage slot'
  )
}

const enterActiveStage = async (poa, fmr) => {
  // move into "EthFunding" stage
  const neededTime = await determineNeededTimeTravel(poa)
  await timeTravel(neededTime)
  await testStartEthSale(poa)

  // move into "FundingSuccessful" stage
  await testBuyRemainingTokens(poa, {
    from: whitelistedPoaBuyers[0],
    gasPrice
  })

  await testUpdateProofOfCustody(poa, defaultIpfsHashArray32, {
    from: custodian
  })

  await testPayActivationFee(poa, fmr)

  // move into "Active" stage
  await testActivate(poa, fmr, {
    from: custodian
  })

  // clean out broker balance for easier debugging
  await testBrokerClaim(poa)
}

/*
  assumes that:
  - enterActiveStage() has been run to give buy all tokens as whitelistedPoaBuyers[0]
  - testApprove() has been run to give whitelistedPoaBuyers[1] approval to spend whitelistedPoaBuyers[0]'s tokens
*/
const checkPostActiveStorage = async (poa, reg, pmr) => {
  // get all storage
  const storage = await getAllSequentialStorage(poa.address)

  // proxy storage
  const { poaCrowdsaleMaster, registry } = parseProxyCommonStorage(
    storage,
    true
  )

  // common storage
  const {
    actualBroker,
    actualCustodian,
    actualFiatCurrency32,
    commonTotalSupply,
    crowdsaleInitialized,
    durationForActivationPeriod,
    durationForEthFundingPeriod,
    fundedEthAmountInWei,
    fundedFiatAmountInCents,
    fundedFiatAmountInTokens,
    fundingGoalInCents,
    paused,
    proofOfCustody32,
    stage,
    startTimeForEthFundingPeriod,
    tokenInitialized
  } = await parseCommonStorage(storage, true)

  // token storage
  const { allowed, actualOwner, name, symbol } = parseTokenStorage(storage)

  // get needed value from registry
  const actualCrowdsaleMaster = await reg.getContractAddress(
    'PoaCrowdsaleMaster'
  )

  assert.equal(allowed, '0x00', 'expected allowed slot should be empty')
  assert.equal(
    actualOwner,
    pmr.address,
    'owner should be in correct storage slot'
  )
  assert.equal(name, defaultName, 'name32 should be in correct storage slot')
  assert.equal(
    symbol,
    defaultSymbol,
    'symbol32 should be in correct storage slot'
  )
  assert.equal(
    stage.toString(),
    stages.Active,
    'stage should be in PreFunding stage'
  )
  assert.equal(
    actualCustodian,
    custodian,
    'custodian should match correct address'
  )
  assert.deepEqual(
    proofOfCustody32,
    defaultIpfsHashArray32,
    'proofOfCustody32 should be empty'
  )
  assert.equal(
    commonTotalSupply.toString(),
    defaultTotalSupply.toString(),
    'commonTotalSupply should match defaultTotalSupply'
  )
  assert.equal(
    fundedFiatAmountInTokens.toString(),
    '0',
    'fundedFiatAmountInTokens should be 0'
  )
  assert(
    fundedEthAmountInWei.greaterThan(0),
    'fundedEthAmountInWei should be greater than 0'
  )
  assert.equal(registry, reg.address, 'registry should match reg.address')
  assert(!paused, 'paused should be false')
  assert(tokenInitialized, 'tokenInitialized should be true')
  assert.equal(
    poaCrowdsaleMaster,
    actualCrowdsaleMaster,
    'poaCrowdsaleMaster should match actualCrowdsaleMaster'
  )

  assert(crowdsaleInitialized, 'crowdsaleInitialized should be true')
  assert(
    startTimeForEthFundingPeriod.greaterThan(1530280851),
    'startTimeForEthFundingPeriod should be greater than 06/29/2018'
  )
  assert.equal(
    durationForEthFundingPeriod.toString(),
    defaultFundingTimeout.toString(),
    'durationForEthFundingPeriod should match defaultFundingTimeout'
  )
  assert(
    durationForActivationPeriod.greaterThan(durationForEthFundingPeriod),
    'durationForActivationPeriod should be greater than durationForEthFundingPeriod'
  )
  assert.equal(
    actualFiatCurrency32,
    defaultFiatCurrency,
    'actualFiatCurrency32 should conver to match fiatCurrency'
  )
  assert.equal(
    fundingGoalInCents.toString(),
    defaultFundingGoal.toString(),
    'fundingGoalInCents should match defaultFundingGoal'
  )
  assert.equal(
    fundedFiatAmountInCents.toString(),
    '0',
    'fundedFiatAmountInCents should be 0'
  )
  assert.equal(actualBroker, broker, 'actualBroker should match broker')
  // get needed mapping values to check on values
  const investmentPerUserInWei = await getMappingStorage(
    poa.address,
    11,
    whitelistedPoaBuyers[0]
  )
  const {
    nestedMappingValueStorage: allowedValue
  } = await getNestedMappingStorage(
    poa.address,
    27,
    whitelistedPoaBuyers[0],
    whitelistedPoaBuyers[1]
  )
  assert.equal(
    new BigNumber(allowedValue).toString(),
    new BigNumber(3e18).toString(),
    'allowed for buyers should be in correct slot'
  )

  // Since we have a rate penalty (test default: 2%), user has to invest
  // more wei in order to reach fiatGoalInCents. How much more can be calculated
  // by the rate difference (important: integer divison in Solidity makes it
  // approximately 2%, not exactly)
  assert.equal(
    new BigNumber(investmentPerUserInWei).toString(),
    // calculated based on default values for poa tests
    new BigNumber('15000150001500015000')
      .times(defaultFiatRate) // initial fiat rate
      .dividedBy(defaultPenalizedFiatRate) // penalized fiat rate with default penalty (~2%). It is not exactly 2% because of integer division in Solidity
      .toFixed(0, 1),
    'investmentPerUserInWei should match expected value'
  )
}

const checkPostIsUpgradedStorage = async (poa, reg, pmr) => {
  // get all storage
  const storage = await getAllSequentialStorage(poa.address)
  // proxy storage
  const {
    poaTokenMaster,
    poaCrowdsaleMaster,
    registry
  } = parseProxyCommonStorage(storage, true)
  // common storage
  const {
    actualBroker,
    actualCustodian,
    actualFiatCurrency32,
    commonTotalSupply,
    crowdsaleInitialized,
    durationForActivationPeriod,
    durationForEthFundingPeriod,
    fundedEthAmountInWei,
    fundedFiatAmountInCents,
    fundedFiatAmountInTokens,
    fundingGoalInCents,
    paused,
    proofOfCustody32,
    stage,
    startTimeForEthFundingPeriod,
    tokenInitialized
  } = await parseCommonStorage(storage, true)
  // token storage
  const { allowed, actualOwner, name, symbol } = parseTokenStorage(storage)

  // get needed contract values from registry for testing
  const actualTokenMaster = await reg.getContractAddress('PoaTokenMaster')
  const actualCrowdsaleMaster = await reg.getContractAddress(
    'PoaCrowdsaleMaster'
  )

  assert.equal(allowed, '0x00', 'expected allowed slot should be empty')
  assert.equal(
    actualOwner,
    pmr.address,
    'owner should be in correct storage slot'
  )
  assert.equal(name, defaultName, 'name32 should be in correct storage slot')
  assert.equal(
    symbol,
    defaultSymbol,
    'symbol32 should be in correct storage slot'
  )

  assert.equal(
    stage.toString(),
    stages.Active,
    'stage should be in PreFunding stage'
  )
  assert.equal(
    actualCustodian,
    custodian,
    'custodian should match correct address'
  )
  assert.deepEqual(
    proofOfCustody32,
    defaultIpfsHashArray32,
    'proofOfCustody32 should be empty'
  )
  assert.equal(
    commonTotalSupply.toString(),
    defaultTotalSupply.toString(),
    'commonTotalSupply should match defaultTotalSupply'
  )
  assert.equal(
    fundedFiatAmountInTokens.toString(),
    '0',
    'fundedFiatAmountInTokens should be 0'
  )
  assert(
    fundedEthAmountInWei.greaterThan(0),
    'fundedEthAmountInWei should be greater than 0'
  )
  assert.equal(registry, reg.address, 'registry should match reg.address')
  assert(!paused, 'paused should be false')
  assert(tokenInitialized, 'tokenInitialized should be true')
  assert.equal(
    poaTokenMaster,
    actualTokenMaster,
    'poaTokenMaster should match actualTokenMaster'
  )
  assert.equal(
    poaCrowdsaleMaster,
    actualCrowdsaleMaster,
    'poaCrowdsaleMaster should match actualCrowdsaleMaster'
  )

  assert(crowdsaleInitialized, 'crowdsaleInitialized should be true')
  assert(
    startTimeForEthFundingPeriod.greaterThan(1530280851),
    'startTimeForEthFundingPeriod should be greater than 06/29/2018'
  )
  assert.equal(
    durationForEthFundingPeriod.toString(),
    defaultFundingTimeout.toString(),
    'durationForEthFundingPeriod should match defaultFundingTimeout'
  )
  assert(
    durationForActivationPeriod.greaterThan(durationForEthFundingPeriod),
    'durationForActivationPeriod should be greater than durationForEthFundingPeriod'
  )
  assert.equal(
    actualFiatCurrency32,
    defaultFiatCurrency,
    'actualFiatCurrency32 should conver to match fiatCurrency'
  )
  assert.equal(
    fundingGoalInCents.toString(),
    defaultFundingGoal.toString(),
    'fundingGoalInCents should match defaultFundingGoal'
  )
  assert.equal(
    fundedFiatAmountInCents.toString(),
    '0',
    'fundedFiatAmountInCents should be 0'
  )
  assert.equal(actualBroker, broker, 'actualBroker should match broker')

  // get needed mapping storage for testing
  const investmentPerUserInWei = await getMappingStorage(
    poa.address,
    11,
    whitelistedPoaBuyers[0]
  )
  const {
    nestedMappingValueStorage: allowedValue
  } = await getNestedMappingStorage(
    poa.address,
    27,
    whitelistedPoaBuyers[0],
    whitelistedPoaBuyers[1]
  )

  assert.equal(
    new BigNumber(allowedValue).toString(),
    new BigNumber(3e18).toString(),
    'allowed for buyers should be in correct slot'
  )
  assert.equal(
    new BigNumber(investmentPerUserInWei).toString(),
    // calculated based on default values for poa tests
    new BigNumber('15000150001500015000')
      .times(defaultFiatRate) // initial fiat rate
      .dividedBy(defaultPenalizedFiatRate) // penalized fiat rate with default penalty (~2%). It is not exactly 2% because of integer division in Solidity
      .toFixed(0, 1), // cut off decimals to simulate integer division in Solidity
    'investmentPerUserInWei should match expected value'
  )

  //
  // start upgraded storage
  //

  // isUpgraded is packed in with bool whitelistTransfers at slot 28
  const isUpgraded = parseInt(storage[28].data.slice(0, 4))

  assert(isUpgraded, 'isUpgraded should be true in correct slot')
}

module.exports = {
  checkPreInitializedStorage,
  initializeContract,
  checkPostInitializedStorage,
  enterActiveStage,
  checkPostActiveStorage,
  checkPostIsUpgradedStorage
}
