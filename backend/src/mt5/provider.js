/**
 * Mt5Provider interface (one instance per account). All methods are async.
 *
 *   connectAccount()                    -> void   (throws Mt5Error)
 *   disconnect()                        -> void
 *   fetchAccountInfo()                  -> { balance, equity, margin, freeMargin, currency, leverage }
 *   fetchPositions()                    -> Position[]
 *   fetchOrders()                       -> Order[]
 *   fetchHistory({ days })              -> Deal[]
 *   getSymbolInfo(symbol)               -> { symbol, point, digits, pipSize, tickValue, volumeMin, volumeMax, volumeStep }
 *   placeOrder({ symbol, type, volume, sl, tp, magic, comment }) -> { ticket }
 *   modifyPosition(ticket, { sl, tp })  -> void
 *   closePosition(ticket, volume?)      -> void   (partial close when volume < position volume)
 *
 * Position: { ticket, symbol, type: 'buy'|'sell', volume, openPrice, currentPrice,
 *             sl, tp (0 = unset), profit, magic, comment, openTime }
 *
 * Errors: throw Mt5Error({ transient }) so the caller can retry connectivity issues.
 */
export const PROVIDER_METHODS = [
  'connectAccount',
  'disconnect',
  'fetchAccountInfo',
  'fetchPositions',
  'fetchOrders',
  'fetchHistory',
  'getSymbolInfo',
  'placeOrder',
  'modifyPosition',
  'closePosition',
];
