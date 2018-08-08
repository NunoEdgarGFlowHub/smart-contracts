pragma solidity 0.4.24;

import "./PoaCommon.sol";

/* solium-disable security/no-block-members */
/* solium-disable security/no-low-level-calls */


/**
  @title This contract acts as a master copy for use with PoaProxy in conjunction
  with PoaToken. Storage is assumed to be set on PoaProxy through
  delegatecall in fallback function. This contract handles the
  crowdsale functionality of PoaProxy. Inherited PoaCommon dictates
  common storage slots as well as common functions used by both PoaToken
  and PoaCrowdsale.
*/
contract PoaCrowdsale is PoaCommon {

  uint256 public constant crowdsaleVersion = 1;

  // Number of digits included during the percent calculation
  uint256 public constant precisionOfPercentCalc = 18;

  event Unpause();

  /******************
  * start modifiers *
  ******************/

  /// @notice Ensure that the contract has not timed out
  modifier checkTimeout() {
    uint256 fundingDeadline = startTimeForEthFunding.add(endTimeForEthFunding);
    uint256 activationDeadline = startTimeForEthFunding
      .add(endTimeForEthFunding)
      .add(activationTimeout);

    if (
      (uint256(stage) < 3 && block.timestamp >= fundingDeadline) ||
      (stage == Stages.FundingSuccessful && block.timestamp >= activationDeadline)
    ) {
      enterStage(Stages.TimedOut);
    }

    _;
  }

  /// @notice Ensure that a buyer is whitelisted before buying
  modifier isBuyWhitelisted() {
    require(isWhitelisted(msg.sender));
    _;
  }

  /****************
  * end modifiers *
  ****************/

  /**
    @notice Proxied contracts cannot have constructors. This works in place
    of the constructor in order to initialize the contract storage.

    @param _fiatCurrency32         bytes32 of fiat currency string
    @param _startTimeForEthFunding Beginning of the sale as unix timestamp
    @param _endTimeForEthFunding   Duration of the sale (starting from _startTimeForEthFunding)
    @param _activationTimeout      Timeframe for the custodian to activate the token (starting from _startTimeForEthFunding + _endTimeForEthFunding)
    @param _fundingGoalInCents     Funding goal in fiat cents (e.g. a €10,000 fundingGoal would be '10000000')
  */
  function initializeCrowdsale(
    bytes32 _fiatCurrency32,
    uint256 _startTimeForEthFunding,
    uint256 _endTimeForEthFunding,
    uint256 _activationTimeout,
    uint256 _fundingGoalInCents
  )
    external
    returns (bool)
  {
    // ensure that token has already been initialized
    require(tokenInitialized);
    // ensure that crowdsale has not already been initialized
    require(!crowdsaleInitialized);

    // validate initialize parameters
    require(_fiatCurrency32 != bytes32(0));
    require(_startTimeForEthFunding > block.timestamp);
    require(_endTimeForEthFunding >= 60 * 60 * 24);
    require(_activationTimeout >= 60 * 60 * 24 * 7);
    require(_fundingGoalInCents > 0);
    require(totalSupply_ > _fundingGoalInCents);

    // initialize non-sequential storage
    fiatCurrency32 = _fiatCurrency32;
    startTimeForEthFunding = _startTimeForEthFunding;
    endTimeForEthFunding = _endTimeForEthFunding;
    activationTimeout = _activationTimeout;
    fundingGoalInCents = _fundingGoalInCents;

    // run getRate once in order to see if rate is initialized, throws if not
    require(getFiatRate() > 0);

    // set crowdsaleInitialized to true so cannot be initialized again
    crowdsaleInitialized = true;

    return true;
  }

  /****************************
  * start lifecycle functions *
  ****************************/

  /// @notice Used for moving contract into FiatFunding stage where fiat purchases can be made
  function startFiatSale()
    external
    onlyBroker
    atStage(Stages.PreFunding)
    returns (bool)
  {
    enterStage(Stages.FiatFunding);
    return true;
  }

  /// @notice Used for starting ETH sale as long as startTimeForEthFunding has passed
  function startEthSale()
    external
    atEitherStage(Stages.PreFunding, Stages.FiatFunding)
    returns (bool)
  {
    require(block.timestamp >= startTimeForEthFunding);
    enterStage(Stages.EthFunding);
    return true;
  }

  /// @notice Used for the calculation of token amount to be given to FIAT investor
  function calculateTokenAmountForAmountInCents
  (
    uint256 _amountInCents
  )
    public
    view
    returns(uint256)
  {
    //_percentOfFundingGoal multipled by precisionOfPercentCalc to get a more accurate result
    uint256 _percentOfFundingGoal = percent(_amountInCents, fundingGoalInCents, precisionOfPercentCalc);
    return totalSupply_.mul(_percentOfFundingGoal).div(10 ** precisionOfPercentCalc);
  }

  /**
    @notice Used for fiat investments during 'FiatFunding' stage.
    All fiat balances are updated manually by the custodian.
   */
  function buyFiat
  (
    address _contributor,
    uint256 _amountInCents
  )
    external
    atStage(Stages.FiatFunding)
    onlyCustodian
    returns (bool)
  {
    // Do not allow funding less than 100 cents
    require(_amountInCents >= 100);

    uint256 _newFundedFiatAmountInCents = fundedFiatAmountInCents.add(_amountInCents);

    // Make sure, investment amount isn't higher than the funding goal.
    // This is also a little protection against typos with one too many zeros :)
    if (fundingGoalInCents.sub(_newFundedFiatAmountInCents) >= 0) {

      // update total fiat funded amount in cents
      fundedFiatAmountInCents = fundedFiatAmountInCents
        .add(_amountInCents);

      // update total fiat funded amount in tokens
      uint256 _tokenAmount = calculateTokenAmountForAmountInCents(_amountInCents);
      fundedFiatAmountInTokens = fundedFiatAmountInTokens
        .add(_tokenAmount);

      // update balance of fiat investor
      fundedFiatAmountPerUserInTokens[_contributor] = fundedFiatAmountPerUserInTokens[_contributor]
        .add(_tokenAmount);

      // if funded amount reaches the funding goal, enter FundingSuccessful stage
      if (fundedFiatAmountInCents >= fundingGoalInCents) {
        enterStage(Stages.FundingSuccessful);
      }

      return true;
    } else {
      return false;
    }
  }

  function removeFiat
  (
    address _contributor,
    uint256 _amountInCents
  )
    external
    atStage(Stages.FiatFunding)
    onlyCustodian
    returns(bool)
  {
    require(_amountInCents >= 0);

    uint256 _tokenAmount = calculateTokenAmountForAmountInCents(_amountInCents);

    // update funded fiat amount totals
    fundedFiatAmountInCents = fundedFiatAmountInCents.sub(_amountInCents);
    fundedFiatAmountInTokens = fundedFiatAmountInTokens.sub(_tokenAmount);

    // update balance of investor
    fundedFiatAmountPerUserInTokens[_contributor] = fundedFiatAmountPerUserInTokens[_contributor].sub(_tokenAmount);

    return true;
  }

  /// @notice Used for funding through ETH during the 'EthFunding' stage
  function buy()
    external
    payable
    checkTimeout
    atStage(Stages.EthFunding)
    isBuyWhitelisted
    returns (bool)
  {
    // prevent FiatFunding addresses from contributing to funding to keep total supply correct
    if (isFiatInvestor(msg.sender)) {
      return false;
    }

    /*
     * In case ETH went up in value against Fiat, weiToFiatCents(fundedEthAmountInWei)
     * could have tipped us over the fundingGoal in which case we want to:
     * 1. Enter the 'FundingSuccessful' stage
     * 2. Refund the sent ETH amount immediately
     * 3. Return 'false' to prevent a case where buying after reaching fundingGoal results in a buyer earning money
     */
    if (weiToFiatCents(fundedEthAmountInWei) > fundingGoalInCents) {
      enterStage(Stages.FundingSuccessful);
      if (msg.value > 0) {
        msg.sender.transfer(msg.value);
      }
      return false;
    }

    // Get total funded amount (Fiat funding + ETH funding incl. this investment)
    // with the most current ETH <> Fiat exchange rate available
    uint256 _totalFundedAmountInCents = weiToFiatCents(fundedEthAmountInWei.add(msg.value))
      .add(fundedFiatAmountInCents);

    // check if funding goal was met
    if (_totalFundedAmountInCents < fundingGoalInCents) {
      // give a range due to fun fun integer division
      if (fundingGoalInCents.sub(_totalFundedAmountInCents) > 1) {
        // continue sale if more than 1 fiat cent is missing from funding goal
        return buyAndContinueFunding(msg.value);
      } else {
        // Finish sale if less than 1 fiat cent is missing from funding goal.
        // No refunds for overpayment should be given for these tiny amounts.
        return buyAndEndFunding(false);
      }
    } else {
      // Finish sale if funding goal was met.
      // A refund for overpayment should be given.
      return buyAndEndFunding(true);
    }
  }

  /// @notice Buy and continue funding process (when funding goal not met)
  function buyAndContinueFunding(uint256 _payAmount)
    internal
    returns (bool)
  {
    // Track investment amount per user in case a user needs
    // to reclaim their funds in case of a failed funding
    fundedEthAmountPerUserInWei[msg.sender] = fundedEthAmountPerUserInWei[msg.sender]
      .add(_payAmount);

    // Increment the funded amount
    fundedEthAmountInWei = fundedEthAmountInWei.add(_payAmount);

    getContractAddress("PoaLogger").call(
      bytes4(keccak256("logBuyEvent(address,uint256)")), msg.sender, _payAmount
    );

    return true;
  }

  /// @notice Buy and finish funding process (when funding goal met)
  function buyAndEndFunding(
    bool _shouldRefund
  )
    internal
    returns (bool)
  {
    enterStage(Stages.FundingSuccessful);
    uint256 _refundAmount = _shouldRefund ?
      fundedEthAmountInWei.add(msg.value).sub(fiatCentsToWei(fundingGoalInCents)) :
      0;

    // Transfer refund amount back to user
    msg.sender.transfer(_refundAmount);

    // Actual Ξ amount to buy after refund
    uint256 _payAmount = msg.value.sub(_refundAmount);
    buyAndContinueFunding(_payAmount);

    return true;
  }

  /// @notice check if fundingGoalInCents has been met due to fluctuating fiat rates
  function checkFundingSuccessful()
    external
    atEitherStage(Stages.FiatFunding, Stages.EthFunding)
    returns (bool)
  {
    uint256 _currentFundedCents = weiToFiatCents(fundedEthAmountInWei);

    if (_currentFundedCents >= fundingGoalInCents) {
      enterStage(Stages.FundingSuccessful);
      return true;
    }

    return false;
  }

  function calculateTotalFee()
    public
    view
    atStage(Stages.FundingSuccessful)
    returns(uint256)
  {
    uint256 _fundedFiatAmountInWei = fiatCentsToWei(fundedFiatAmountInCents);
    uint256 _fiatFee = calculateFee(_fundedFiatAmountInWei);
    uint256 _ethFee = calculateFee(fundedEthAmountInWei);

    return _fiatFee.add(_ethFee);
  }

  function payActivationFee()
    public
    payable
    atStage(Stages.FundingSuccessful)
    returns(bool)
  {
    require(initialFeePaid == false);

    uint256 _totalFee = calculateTotalFee();
    uint256 payedAmountToCalculatedFeeRatio = percent(msg.value, _totalFee, precisionOfPercentCalc);

    // percent of difference should be lower then 0.05%
    require(payedAmountToCalculatedFeeRatio > 1e18 - 5e16);
    require(payedAmountToCalculatedFeeRatio < 1e18 + 5e16);

    // fee sent to FeeManager where fee gets
    // turned into ACT for lockedBBK holders
    payFee(msg.value);

    initialFeePaid = true;

    return true;
  }

  /// @notice Activate token with proofOfCustody fee is taken from contract balance
  /// brokers must work this into their funding goals
  function activate()
    external
    checkTimeout
    onlyCustodian
    atStage(Stages.FundingSuccessful)
    returns (bool)
  {
    // if activated and fee paid: put in Active stage
    require(initialFeePaid);
    enterStage(Stages.Active);

    getContractAddress("PoaLogger")
      .call(bytes4(keccak256("logProofOfCustodyUpdatedEvent()")));
    // balance of contract (fundingGoalInCents) set to claimable by broker.
    // can now be claimed by broker via claim function
    // should only be buy()s - fee. this ensures buy() dust is cleared
    unclaimedPayoutTotals[broker] = unclaimedPayoutTotals[broker]
      .add(address(this).balance);
    // allow trading of tokens
    paused = false;
    // let world know that this token can now be traded.
    emit Unpause();

    return true;
  }

  /**
   @notice Used for manually setting Stage to TimedOut when no users have bought any tokens
   if no `buy()`s occurred before the funding deadline token would be stuck in Funding
   can also be used when activate is not called by custodian within activationTimeout
   lastly can also be used when no one else has called reclaim.
  */
  function setStageToTimedOut()
    external
    atEitherStage(Stages.EthFunding, Stages.FundingSuccessful)
    checkTimeout
    returns (bool)
  {
    if (stage != Stages.TimedOut) {
      revert();
    }
    return true;
  }

  /// @notice Users can reclaim their invested ETH if the funding goal was not met within the funding deadline
  function reclaim()
    external
    checkTimeout
    atStage(Stages.TimedOut)
    returns (bool)
  {
    require(!isFiatInvestor(msg.sender));
    totalSupply_ = 0;
    uint256 _refundAmount = fundedEthAmountPerUserInWei[msg.sender];
    fundedEthAmountPerUserInWei[msg.sender] = 0;
    require(_refundAmount > 0);
    fundedEthAmountInWei = fundedEthAmountInWei.sub(_refundAmount);
    msg.sender.transfer(_refundAmount);
    getContractAddress("PoaLogger").call(
      bytes4(keccak256("logReclaimEvent(address,uint256)")),
      msg.sender,
      _refundAmount
    );
    return true;
  }

  /**
    @notice When something goes wrong during the "PreFunding" or "FiatFunding"
    stages, this is an escape hatch to cancel the funding process.
    If the contract hits the "EthFunding" stage, this can no longer be used.

    This is a nuclear option and should only be used under exceptional
    circumstances, for example:
    - Asset gets damaged due to natural catastrophe
    - Legal issue arises with the asset
    - Broker gets blacklisted during the funding phase
      due to fraudulent behavior
    */
  function cancelFunding()
    external
    onlyCustodian
    atEitherStage(Stages.PreFunding, Stages.FiatFunding)
    returns (bool)
  {
    enterStage(Stages.FundingCancelled);

    return true;
  }

  /**************************
  * end lifecycle functions *
  **************************/

  /**************************
  * start utility functions *
  **************************/

  /// @notice Convert to accurate percent using desired level of precision
  function percent(
    uint256 _numerator,
    uint256 _denominator,
    uint256 _precision
  )
    public
    pure
    returns(uint256)
  {

    // caution, check safe-to-multiply here
    uint256 _safeNumerator = _numerator.mul(10 ** (_precision + 1));
    // with rounding of last digit
    uint256 _quotient = _safeNumerator.div(_denominator).add(5).div(10);
    return (_quotient);
  }

  /// @notice gas saving call to get fiat rate without interface
  function getFiatRate()
    public
    view
    returns (uint256 _fiatRate)
  {
    bytes4 _sig = bytes4(keccak256("getRate32(bytes32)"));
    address _exchangeRates = getContractAddress("ExchangeRates");
    bytes32 _fiatCurrency = keccak256(fiatCurrency());

    assembly {
      let _call := mload(0x40) // set _call to free memory pointer
      mstore(_call, _sig) // store _sig at _call pointer
      mstore(add(_call, 0x04), _fiatCurrency) // store _fiatCurrency at _call offset by 4 bytes for pre-existing _sig

      // staticcall(g, a, in, insize, out, outsize) => 0 on error 1 on success
      let success := staticcall(
        gas,             // g = gas: whatever was passed already
        _exchangeRates,  // a = address: address from getContractAddress
        _call,           // in = mem in  mem[in..(in+insize): set to free memory pointer
        0x24,            // insize = mem insize  mem[in..(in+insize): size of sig (bytes4) + bytes32 = 0x24
        _call,           // out = mem out  mem[out..(out+outsize): output assigned to this storage address
        0x20             // outsize = mem outsize  mem[out..(out+outsize): output should be 32byte slot (uint256 size = 0x20 = slot size 0x20)
      )

      // revert if not successful
      if iszero(success) {
        revert(0, 0)
      }

      _fiatRate := mload(_call) // assign result to return value
      mstore(0x40, add(_call, 0x24)) // advance free memory pointer by largest _call size
    }
  }

  /// @notice Returns fiat value in cents of given wei amount
  function weiToFiatCents(uint256 _wei)
    public
    view
    returns (uint256)
  {
    // get eth to fiat rate in cents from ExchangeRates
    return _wei.mul(getFiatRate()).div(1e18);
  }

  /// @notice Returns wei value from fiat cents
  function fiatCentsToWei(uint256 _cents)
    public
    view
    returns (uint256)
  {
    return _cents.mul(1e18).div(getFiatRate());
  }

  /// @notice Get funded ETH amount in cents
  function fundedEthAmountInCents()
    external
    view
    returns (uint256)
  {
    return weiToFiatCents(fundedEthAmountInWei);
  }

  /// @notice Get fundingGoal in wei
  function fundingGoalInWei()
    external
    view
    returns (uint256)
  {
    return fiatCentsToWei(fundingGoalInCents);
  }

  /************************
  * end utility functions *
  ************************/

  /************************
  * start regular getters *
  ************************/

  /// @notice Return converted string from bytes32 fiatCurrency32
  function fiatCurrency()
    public
    view
    returns (string)
  {
    return to32LengthString(fiatCurrency32);
  }

  /**********************
  * end regular getters *
  **********************/
}
