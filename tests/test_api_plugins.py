"""
Tests for Plugins API endpoints.
"""

import pytest


class TestPluginsAPI:
    """Test plugins API endpoints."""

    def test_list_plugins(self, client):
        """Test listing all plugins."""
        response = client.get("/api/plugins")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_list_installed_plugins(self, client):
        """Test listing installed plugins."""
        response = client.get("/api/plugins/installed")
        assert response.status_code == 200
        data = response.json()
        assert "plugins" in data
        assert "count" in data
        assert isinstance(data["plugins"], list)

    def test_get_plugin_details(self, client):
        """Test getting details of a specific plugin."""
        # First list plugins to get a valid ID
        list_response = client.get("/api/plugins")
        plugins = list_response.json()
        if plugins:
            plugin_id = plugins[0].get("id") or plugins[0].get("name")
            response = client.get(f"/api/plugins/{plugin_id}")
            # Plugin may exist or not
            assert response.status_code in [200, 404]

    def test_discover_plugins(self, client):
        """Test plugin discovery."""
        response = client.post("/api/plugins/discover")
        assert response.status_code == 200
        data = response.json()
        assert "discovered" in data or "plugins" in data or isinstance(data, dict)


class TestPluginSecurityAPI:
    """Test plugin security endpoints."""

    def test_get_security_audit(self, client):
        """Test getting security audit."""
        response = client.get("/api/plugins/security/audit")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)

    def test_get_security_permissions(self, client):
        """Test getting security permissions."""
        response = client.get("/api/plugins/security/permissions")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, (list, dict))

    def test_get_pending_approvals(self, client):
        """Test getting pending permission approvals."""
        response = client.get("/api/plugins/security/pending")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, (list, dict))
