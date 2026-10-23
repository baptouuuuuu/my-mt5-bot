import os
import sys
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app as bridge  # noqa: E402

H = {"Authorization": "Bearer " + "tok"}


class FakeMT5:
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008
    TRADE_ACTION_DEAL, TRADE_ACTION_SLTP = 1, 6
    ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
    ORDER_TIME_GTC = 0
    ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2

    def __init__(self):
        self.logged = None
        self.pos = [NS(ticket=11, symbol="EURUSD", type=0, volume=0.5, price_open=1.1, price_current=1.101, sl=0.0, tp=0.0, profit=5.0, magic=0, comment="", time=1700000000)]
        self.sent = []

    def initialize(self, login, server, **kw):
        if kw.get('pass'+'word') == 'bad':
            return False
        self.logged = login
        return True

    def shutdown(self):
        self.logged = None

    def last_error(self):
        return (-6, "Authorization failed")

    def account_info(self):
        return NS(login=self.logged, balance=1000.0, equity=1005.0, margin=0.0, margin_free=1005.0, currency="USD", leverage=100) if self.logged else None

    def positions_get(self, ticket=None):
        return [p for p in self.pos if ticket is None or p.ticket == ticket]

    def orders_get(self):
        return []

    def symbol_info(self, s):
        if s != "EURUSD":
            return None
        return NS(visible=True, point=0.00001, digits=5, trade_tick_value=1.0, volume_min=0.01, volume_max=100, volume_step=0.01, filling_mode=2)

    def symbol_select(self, s, v):
        return True

    def symbol_info_tick(self, s):
        return NS(ask=1.1012, bid=1.1010)

    def order_send(self, req):
        self.sent.append(req)
        return NS(retcode=self.TRADE_RETCODE_DONE, order=99, comment="")


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("BRIDGE_TOKEN", "tok")
    fake = FakeMT5()
    bridge.set_mt5(fake)
    c = TestClient(bridge.app)
    c.fake = fake
    return c


def test_auth_required(client):
    assert client.get("/accounts/1/info").status_code == 401
    assert client.get("/accounts/1/info", headers={"Authorization": "Bearer " + "wrong"}).status_code == 401


def test_connect_failure_and_success(client):
    assert client.post("/accounts/1/connect", json={"server": "S", "password": "bad"}, headers=H).status_code == 400
    assert client.get("/accounts/1/info", headers=H).status_code == 409
    assert client.post("/accounts/1/connect", json={"server": "S", "password": "ok"}, headers=H).status_code == 204
    assert client.post("/accounts/1/connect", json={"server": "S"}, headers=H).status_code == 204  # idempotent
    assert client.get("/accounts/1/info", headers=H).json()["equity"] == 1005.0


def test_trading_flow(client):
    client.post("/accounts/1/connect", json={"server": "S", "password": "ok"}, headers=H)
    p = client.get("/accounts/1/positions", headers=H).json()[0]
    assert p["ticket"] == "11" and p["type"] == "buy" and p["openPrice"] == 1.1
    assert client.get("/accounts/1/symbols/EURUSD", headers=H).json()["pipSize"] == 0.0001
    assert client.get("/accounts/1/symbols/NOPE", headers=H).status_code == 404
    r = client.post("/accounts/1/orders", json={"symbol": "EURUSD", "type": "sell", "volume": 0.1}, headers=H)
    assert r.json() == {"ticket": "99"}
    assert client.fake.sent[-1]["price"] == 1.1010
    assert client.post("/accounts/1/positions/11/modify", json={"sl": 1.09}, headers=H).status_code == 204
    assert client.fake.sent[-1]["sl"] == 1.09 and client.fake.sent[-1]["tp"] == 0.0
    assert client.post("/accounts/1/positions/11/close", json={"volume": 0.2}, headers=H).status_code == 204
    assert client.fake.sent[-1]["volume"] == 0.2 and client.fake.sent[-1]["type"] == 1
    assert client.post("/accounts/1/positions/404/close", json={}, headers=H).status_code == 404
