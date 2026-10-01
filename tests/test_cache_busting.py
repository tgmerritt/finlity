"""The dashboard HTML must version both the JS bundle and the stylesheet."""

import re

from src import main


def test_dashboard_versions_js_and_css(client) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    version = main._build_version
    assert f'src="/static/dist/app.js?v={version}"' in resp.text
    assert f'href="/static/style.css?v={version}"' in resp.text
    assert not re.search(r'href="/static/style\.css"', resp.text)
