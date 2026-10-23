"""Bridge HTTP MT5 de référence.

A lancer sur la machine Windows où tourne le terminal MetaTrader 5 (le paquet Python
MetaTrader5 n'existe que pour Windows). Implémente le contrat attendu par
backend/src/mt5/bridgeProvider.js. Un terminal ne gère qu'un compte à la fois :
toutes les requêtes sont sérialisées et le bridge se reconnecte au compte demandé.
"""

import hmac
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

try:  # absent hors Windows ; les tests injectent un faux module
    import MetaTrader5 as mt5
except ImportError:  # pragma: no cover
    mt5 = None

app = FastAPI(title="MT5 bridge", docs_url=None, redoc_url=None)
_lock = threading.RLock()
_state: dict[str, Any] = {"login": None}


def set_mt5(module: Any) -> None:
    """Permet d'injecter un module MT5 (tests)."""
    global mt5
    mt5 = module
    _state["login"] = None


def auth(authorization: str = Header(default="")) -> None:
    token = os.environ.get("BRIDGE_TOKEN", "")
    if not token:
        raise HTTPException(503, "BRIDGE_TOKEN is not configured")
    expected = "Bearer " + token
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, "Unauthorized")


def need_mt5() -> Any:
    if mt5 is None:
        raise HTTPException(503, "MetaTrader5 package unavailable (Windows only)")
    return mt5


def last_error(prefix: str) -> HTTPException:
    code, msg = need_mt5().last_error()
    # codes < -1 : terminal/IPC indisponible -> transitoire (5xx) ; sinon refus (4xx)
    status = 503 if code in (-10001, -10002, -10003, -10004, -10005) else 400
    return HTTPException(status, f"{prefix}: [{code}] {msg}")


class ConnectBody(BaseModel):
    server: str = Field(min_length=1)
    password: Optional[str] = None


class OrderBody(BaseModel):
    symbol: str
    type: str = Field(pattern="^(buy|sell)$")
    volume: float = Field(gt=0)
    sl: float = 0
    tp: float = 0
    magic: int = 0
    comment: str = ""


class ModifyBody(BaseModel):
    sl: Optional[float] = None
    tp: Optional[float] = None


class CloseBody(BaseModel):
    volume: Optional[float] = Field(default=None, gt=0)


def ensure_account(login: str) -> None:
    """Le compte demandé doit être celui actuellement connecté au terminal."""
    if _state["login"] != login:
        raise HTTPException(409, f"Account {login} is not connected; call /connect first")
    info = need_mt5().account_info()
    if info is None or str(info.login) != login:
        _state["login"] = None
        raise HTTPException(503, "Terminal is not logged in to this account")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "mt5": mt5 is not None}


@app.post("/accounts/{login}/connect", status_code=204, dependencies=[Depends(auth)])
def connect(login: str, body: ConnectBody) -> None:
    m = need_mt5()
    with _lock:
        info = m.account_info() if _state["login"] == login else None
        if info is not None and str(info.login) == login:
            return  # déjà connecté (appelé à chaque cycle de synchro)
        if not login.isdigit():
            raise HTTPException(400, "MT5 login must be numeric")
        kwargs: dict[str, Any] = {"login": int(login), "server": body.server}
        if body.password:
            kwargs["password"] = body.password
        path = os.environ.get("MT5_TERMINAL_PATH")
        if path:
            kwargs["path"] = path
        if not m.initialize(**kwargs):
            _state["login"] = None
            raise last_error("MT5 connection failed")
        _state["login"] = login


@app.post("/accounts/{login}/disconnect", status_code=204, dependencies=[Depends(auth)])
def disconnect(login: str) -> None:
    with _lock:
        if _state["login"] == login:
            need_mt5().shutdown()
            _state["login"] = None


@app.get("/accounts/{login}/info", dependencies=[Depends(auth)])
def info(login: str) -> dict:
    with _lock:
        ensure_account(login)
        i = need_mt5().account_info()
        return {
            "balance": i.balance,
            "equity": i.equity,
            "margin": i.margin,
            "freeMargin": i.margin_free,
            "currency": i.currency,
            "leverage": i.leverage,
        }


def _side(t: int) -> str:
    return "buy" if t == 0 else "sell"


@app.get("/accounts/{login}/positions", dependencies=[Depends(auth)])
def positions(login: str) -> list:
    with _lock:
        ensure_account(login)
        res = need_mt5().positions_get()
        if res is None:
            raise last_error("positions_get failed")
        return [
            {
                "ticket": str(p.ticket),
                "symbol": p.symbol,
                "type": _side(p.type),
                "volume": p.volume,
                "openPrice": p.price_open,
                "currentPrice": p.price_current,
                "sl": p.sl,
                "tp": p.tp,
                "profit": p.profit,
                "magic": p.magic,
                "comment": p.comment,
                "openTime": datetime.fromtimestamp(p.time, timezone.utc).isoformat(),
            }
            for p in res
        ]


@app.get("/accounts/{login}/orders", dependencies=[Depends(auth)])
def orders(login: str) -> list:
    with _lock:
        ensure_account(login)
        res = need_mt5().orders_get()
        if res is None:
            raise last_error("orders_get failed")
        return [
            {"ticket": str(o.ticket), "symbol": o.symbol, "type": o.type, "volume": o.volume_current, "price": o.price_open}
            for o in res
        ]


@app.get("/accounts/{login}/history", dependencies=[Depends(auth)])
def history(login: str, days: int = 7) -> list:
    days = min(max(days, 1), 90)
    with _lock:
        ensure_account(login)
        end = datetime.now(timezone.utc)
        res = need_mt5().history_deals_get(end - timedelta(days=days), end + timedelta(days=1))
        if res is None:
            raise last_error("history_deals_get failed")
        return [
            {
                "ticket": str(d.ticket),
                "symbol": d.symbol,
                "type": _side(d.type),
                "volume": d.volume,
                "price": d.price,
                "profit": d.profit,
                "time": datetime.fromtimestamp(d.time, timezone.utc).isoformat(),
            }
            for d in res
            if d.symbol
        ]


@app.get("/accounts/{login}/symbols/{symbol}", dependencies=[Depends(auth)])
def symbol_info(login: str, symbol: str) -> dict:
    with _lock:
        ensure_account(login)
        m = need_mt5()
        s = m.symbol_info(symbol)
        if s is None:
            raise HTTPException(404, f"Unknown symbol {symbol}")
        if not s.visible:
            m.symbol_select(symbol, True)
        pip = s.point * 10 if s.digits in (3, 5) else s.point
        return {
            "symbol": symbol,
            "point": s.point,
            "digits": s.digits,
            "pipSize": pip,
            "tickValue": s.trade_tick_value,
            "volumeMin": s.volume_min,
            "volumeMax": s.volume_max,
            "volumeStep": s.volume_step,
        }


def _filling(m: Any, symbol: str) -> int:
    s = m.symbol_info(symbol)
    mode = getattr(s, "filling_mode", 0)
    if mode & 2:
        return m.ORDER_FILLING_IOC
    if mode & 1:
        return m.ORDER_FILLING_FOK
    return m.ORDER_FILLING_RETURN


def _send(m: Any, request: dict, what: str) -> Any:
    result = m.order_send(request)
    if result is None:
        raise last_error(f"{what} failed")
    if result.retcode not in (m.TRADE_RETCODE_DONE, m.TRADE_RETCODE_PLACED):
        raise HTTPException(400, f"{what} rejected: retcode={result.retcode} {getattr(result, 'comment', '')}")
    return result


@app.post("/accounts/{login}/orders", dependencies=[Depends(auth)])
def place_order(login: str, body: OrderBody) -> dict:
    with _lock:
        ensure_account(login)
        m = need_mt5()
        if m.symbol_info(body.symbol) is None:
            raise HTTPException(404, f"Unknown symbol {body.symbol}")
        m.symbol_select(body.symbol, True)
        tick = m.symbol_info_tick(body.symbol)
        if tick is None:
            raise last_error("No tick")
        buy = body.type == "buy"
        request = {
            "action": m.TRADE_ACTION_DEAL,
            "symbol": body.symbol,
            "volume": body.volume,
            "type": m.ORDER_TYPE_BUY if buy else m.ORDER_TYPE_SELL,
            "price": tick.ask if buy else tick.bid,
            "sl": body.sl,
            "tp": body.tp,
            "deviation": 20,
            "magic": body.magic,
            "comment": body.comment[:31],
            "type_time": m.ORDER_TIME_GTC,
            "type_filling": _filling(m, body.symbol),
        }
        res = _send(m, request, "order_send")
        return {"ticket": str(res.order)}


def _position(m: Any, ticket: str) -> Any:
    if not ticket.isdigit():
        raise HTTPException(400, "Invalid ticket")
    res = m.positions_get(ticket=int(ticket))
    if not res:
        raise HTTPException(404, f"Position {ticket} not found")
    return res[0]


@app.post("/accounts/{login}/positions/{ticket}/modify", status_code=204, dependencies=[Depends(auth)])
def modify(login: str, ticket: str, body: ModifyBody) -> None:
    with _lock:
        ensure_account(login)
        m = need_mt5()
        p = _position(m, ticket)
        _send(
            m,
            {
                "action": m.TRADE_ACTION_SLTP,
                "position": p.ticket,
                "symbol": p.symbol,
                "sl": p.sl if body.sl is None else body.sl,
                "tp": p.tp if body.tp is None else body.tp,
            },
            "modify",
        )


@app.post("/accounts/{login}/positions/{ticket}/close", status_code=204, dependencies=[Depends(auth)])
def close(login: str, ticket: str, body: CloseBody) -> None:
    with _lock:
        ensure_account(login)
        m = need_mt5()
        p = _position(m, ticket)
        volume = body.volume if body.volume and body.volume < p.volume else p.volume
        tick = m.symbol_info_tick(p.symbol)
        if tick is None:
            raise last_error("No tick")
        is_buy = p.type == 0
        _send(
            m,
            {
                "action": m.TRADE_ACTION_DEAL,
                "position": p.ticket,
                "symbol": p.symbol,
                "volume": volume,
                "type": m.ORDER_TYPE_SELL if is_buy else m.ORDER_TYPE_BUY,
                "price": tick.bid if is_buy else tick.ask,
                "deviation": 20,
                "magic": p.magic,
                "comment": "mt5bot close",
                "type_time": m.ORDER_TIME_GTC,
                "type_filling": _filling(m, p.symbol),
            },
            "close",
        )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host=os.environ.get("BRIDGE_HOST", "127.0.0.1"), port=int(os.environ.get("BRIDGE_PORT", "8765")))
