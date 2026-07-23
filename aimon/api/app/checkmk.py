from __future__ import annotations

from typing import Any

import httpx

from app.config import Settings


class CheckmkClient:
    """Thin async wrapper over the Checkmk REST API.

    Docs: <checkmk_url>/... e.g. http://host:5000/cmk/check_mk/api/1.0
    All infra mutations funnel through here so the dashboard never talks to
    Checkmk directly.
    """

    def __init__(self, settings: Settings) -> None:
        self._s = settings
        self._base = settings.checkmk_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {settings.checkmk_user} {settings.checkmk_secret}",
            "Accept": "application/json",
        }

    @property
    def enabled(self) -> bool:
        return self._s.checkmk_enabled

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        url = f"{self._base}{path}"
        headers = {**self._headers, "Content-Type": "application/json"}
        extra_headers = kwargs.pop("headers", None)
        if extra_headers:
            headers.update(extra_headers)
        async with httpx.AsyncClient(timeout=self._s.checkmk_timeout, verify=False) as client:
            return await client.request(method, url, headers=headers, **kwargs)

    async def version(self) -> dict[str, Any]:
        resp = await self._request("GET", "/version")
        resp.raise_for_status()
        return resp.json()

    async def list_hosts(self) -> list[dict[str, Any]]:
        resp = await self._request(
            "GET",
            "/domain-types/host_config/collections/all",
            params={"effective_attributes": "false"},
        )
        resp.raise_for_status()
        out: list[dict[str, Any]] = []
        for item in resp.json().get("value", []):
            attrs = item.get("extensions", {}).get("attributes", {})
            out.append(
                {
                    "name": item.get("id"),
                    "address": attrs.get("ipaddress", ""),
                    "type": "snmp" if attrs.get("tag_snmp_ds") else "agent",
                    "state": "up",
                    "services": 0,
                }
            )
        return out

    async def create_host(
        self,
        name: str,
        address: str,
        *,
        folder: str = "/",
        snmp_community: str | None = None,
    ) -> dict[str, Any]:
        attributes: dict[str, Any] = {}
        if address:
            attributes["ipaddress"] = address
        if snmp_community:
            attributes["tag_agent"] = "no-agent"
            attributes["tag_snmp_ds"] = "snmp-v2"
            attributes["snmp_community"] = snmp_community
        body = {"folder": folder, "host_name": name, "attributes": attributes}
        resp = await self._request(
            "POST",
            "/domain-types/host_config/collections/all",
            json=body,
        )
        if resp.status_code == 400 and "already exists" in resp.text.lower():
            return {"id": name, "exists": True}
        if resp.status_code >= 400:
            detail = resp.text[:500]
            raise httpx.HTTPStatusError(
                f"{resp.status_code} creating host {name}: {detail}",
                request=resp.request,
                response=resp,
            )
        return resp.json()

    async def delete_host(self, name: str) -> None:
        resp = await self._request("DELETE", f"/objects/host_config/{name}")
        if resp.status_code not in (204, 200, 404):
            resp.raise_for_status()

    async def discover_services(self, name: str) -> dict[str, Any]:
        body = {"host_name": name, "mode": "refresh"}
        resp = await self._request(
            "POST",
            "/domain-types/service_discovery_run/actions/start/invoke",
            json=body,
        )
        # discovery may be async / conflict while running — not fatal for add flow
        if resp.status_code not in (200, 204, 302, 409, 422):
            resp.raise_for_status()
        return {"status": resp.status_code}

    async def activate_changes(self) -> dict[str, Any]:
        body = {"redirect": False, "sites": [self._s.checkmk_site], "force_foreign_changes": True}
        resp = await self._request(
            "POST",
            "/domain-types/activation_run/actions/activate-changes/invoke",
            json=body,
            headers={"If-Match": "*"},
        )
        if resp.status_code not in (200, 302, 422):
            detail = resp.text[:500]
            raise httpx.HTTPStatusError(
                f"{resp.status_code} activate: {detail}",
                request=resp.request,
                response=resp,
            )
        return {"status": resp.status_code}

    async def register_and_activate(
        self, name: str, address: str, *, snmp_community: str | None = None
    ) -> dict[str, Any]:
        """Create host → discover services → activate changes (auto-add flow)."""
        created = await self.create_host(name, address, snmp_community=snmp_community)
        try:
            await self.discover_services(name)
        except httpx.HTTPError:
            # Agent may be offline; host is still registered.
            pass
        await self.activate_changes()
        return {"host": name, "activated": True, "exists": bool(created.get("exists"))}
