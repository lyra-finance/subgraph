import {
  GlobalCacheUpdated,
  GreekCacheParametersSet,
  StrikeCacheUpdated,
  BoardCacheUpdated,
} from '../../generated/templates/OptionGreekCache/OptionGreekCache'
import { LiquidityPool as LiquidityPoolContract } from '../../generated/templates/OptionGreekCache/LiquidityPool'
import {
  Global,
  Market,
  MarketTotalValueSnapshot,
  Pool,
  Strike,
  StrikeIVAndGreeksSnapshot,
} from '../../generated/schema'
import { updateMarketGreeks } from '../market'
import { Address, Bytes, dataSource, log } from '@graphprotocol/graph-ts'
import { Entity, HOURLY_PERIODS, HOUR_SECONDS, PERIODS, Snapshot, UNIT, ZERO } from '../lib'

export function handleGlobalCacheUpdated(event: GlobalCacheUpdated): void {
  let context = dataSource.context()
  let optionMarketId = context.getString('market')
  let timestamp = event.block.timestamp.toI32()
  //Update Market: netDelta, netStdVega, netOptionValue
  updateMarketGreeks(
    optionMarketId,
    timestamp,
    event.params.globalCache.netGreeks.netDelta,
    event.params.globalCache.netGreeks.netStdVega,
  )

  //Check if smallest snapshot exists, if so, return
  //We only want to update snapshots once per period, since the on-chain query is expensive
  let market = Market.load(optionMarketId) as Market
  let smallestSnapshotId = Snapshot.getSnapshotID(optionMarketId, HOURLY_PERIODS[0], timestamp)
  let smallestSnapshot = MarketTotalValueSnapshot.load(smallestSnapshotId)

  if (smallestSnapshot != null) {
    return
  }

  //Get Values
  let pool = Pool.load(market.liquidityPool) as Pool
  let lpContract = LiquidityPoolContract.bind(changetype<Address>(Bytes.fromHexString(market.liquidityPool)))
  let tokenPrice = lpContract.try_getTokenPrice()
  let liquidity = lpContract.try_getLiquidity(market.latestSpotPrice)

  //If we fail to get liquidity info, exit
  //This can happen during volatility halts
  if (tokenPrice.reverted || liquidity.reverted) {
    log.error(
      'Failed to get liquidity for: {}, price used: {}, liquidity failed: {} , token failed: {}, blocknum: {} ',
      [
        market.name,
        market.latestSpotPrice.toString(),
        liquidity.reverted.toString(),
        tokenPrice.reverted.toString(),
        event.block.number.toString(),
      ],
    )
    log.error('Reverted', [])
    return
  }

  for (let p = 0; p < HOURLY_PERIODS.length; p++) {

    let snapshot = Entity.loadOrCreateMarketTotalValueSnapshot(optionMarketId, HOURLY_PERIODS[p], timestamp)
    snapshot.netOptionValue = event.params.globalCache.netGreeks.netOptionValue

    snapshot.tokenPrice = tokenPrice.value
    snapshot.NAV = liquidity.value.NAV
    snapshot.freeLiquidity = liquidity.value.freeLiquidity
    snapshot.burnableLiquidity = liquidity.value.burnableLiquidity
    snapshot.usedCollatLiquidity = liquidity.value.usedCollatLiquidity
    snapshot.pendingDeltaLiquidity = liquidity.value.pendingDeltaLiquidity
    snapshot.usedDeltaLiquidity = liquidity.value.usedDeltaLiquidity
    snapshot.baseBalance = (Pool.load(market.liquidityPool) as Pool).baseBalance
    snapshot.pendingDeposits = pool.pendingDeposits
    snapshot.pendingWithdrawals = pool.pendingWithdrawals.times(tokenPrice.value).div(UNIT) //pendingWithdrawals is measured in depositTokens
    market.latestTotalValue = snapshot.id
    snapshot.save()
    market.save()
  }
}

export function handleStrikeCacheUpdated(event: StrikeCacheUpdated): void {
  let context = dataSource.context()
  let optionMarketId = context.getString('market')
  let strike = Entity.loadStrike(optionMarketId, event.params.strikeCache.id)
  strike.skew = event.params.strikeCache.skew
  strike.skewVariance = event.params.strikeCache.skewVariance
  strike.save()

  let timestamp = event.block.timestamp.toI32()

  //Get the largest relevant period
  let base_period = PERIODS[0]
  let period_timestamp = Snapshot.roundTimestamp(timestamp, base_period)
  for (let p = 1; p < PERIODS.length; p++) {
    if (Snapshot.roundTimestamp(timestamp, PERIODS[p]) == period_timestamp) {
      base_period = PERIODS[p]
    }
  }

  let snapshotId = Snapshot.getSnapshotID(strike.id, base_period, timestamp)
  let strikeSnapshot = StrikeIVAndGreeksSnapshot.load(snapshotId)

  if (strikeSnapshot == null) {
    let latestSnapshot = StrikeIVAndGreeksSnapshot.load(
      strike.latestStrikeIVAndGreeks as string,
    ) as StrikeIVAndGreeksSnapshot

    strikeSnapshot = Entity.createStrikeSnapshot(optionMarketId, strike.strikeId, base_period, timestamp)
    strikeSnapshot.board = strike.board
    strikeSnapshot.skew = strike.skew
    strikeSnapshot.skewVariance = strike.skewVariance
    strikeSnapshot.iv = latestSnapshot.iv
    strikeSnapshot.gamma = latestSnapshot.gamma
    strikeSnapshot.vega = latestSnapshot.vega
  } else {
    strikeSnapshot.skewVariance = strike.skewVariance
  }

  strikeSnapshot.save()
}

export function handleBoardCacheUpdated(event: BoardCacheUpdated): void {
  let context = dataSource.context()
  let optionMarketId = context.getString('market')
  let timestamp = event.block.timestamp.toI32()
  let marketTotalValueSnapshot = Entity.loadOrCreateMarketTotalValueSnapshot(optionMarketId, HOUR_SECONDS, timestamp)
  marketTotalValueSnapshot.boardCacheUpdateTimestamp = timestamp
  marketTotalValueSnapshot.save()
}

export function handleGreekCacheParametersSet(event: GreekCacheParametersSet): void {
  let context = dataSource.context()
  let market = Market.load(context.getString('market')) as Market
  market.rateAndCarry = event.params.params.rateAndCarry
  market.save()
}
