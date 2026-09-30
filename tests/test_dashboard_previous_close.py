"""/api/dashboard/data includes previous_close from the price cache."""


def test_dashboard_positions_carry_previous_close(client):
    data = client.get("/api/dashboard/data").json()
    positions = data["positions"]
    assert positions, "demo data should have positions"
    assert all("previous_close" in p for p in positions)
    with_close = [p for p in positions if p["previous_close"] is not None]
    assert with_close, "at least one demo position should have a previous close"
    for p in with_close:
        assert isinstance(p["previous_close"], float)
