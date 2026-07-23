from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from app.config import Settings


def folder_path_to_id(path: str) -> str:
    """Convert Checkmk folder path `/a/b` to object id `~a~b` (root → `~`)."""
    p = (path or "/").strip() or "/"
    if p in ("/", ""):
        return "~"
    parts = [x for x in p.strip("/").split("/") if x]
    return "~" + "~".join(parts) if parts else "~"


def folder_id_to_path(folder_id: str) -> str:
    fid = (folder_id or "~").strip()
    if fid in ("~", "/", ""):
        return "/"
    if fid.startswith("~"):
        parts = [p for p in fid[1:].split("~") if p]
        return "/" + "/".join(parts) if parts else "/"
    if not fid.startswith("/"):
        return "/" + fid
    return fid


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

    # ---------- folders / sites (площадки) ----------
    async def list_folders(self) -> list[dict[str, Any]]:
        resp = await self._request(
            "GET",
            "/domain-types/folder_config/collections/all",
            params={"recursive": "true", "show_hosts": "false"},
        )
        resp.raise_for_status()
        out: list[dict[str, Any]] = [
            {
                "id": "~",
                "path": "/",
                "name": "",
                "title": "Корень",
                "parent": None,
            }
        ]
        for item in resp.json().get("value", []):
            fid = item.get("id") or ""
            ext = item.get("extensions") or {}
            path = folder_id_to_path(fid)
            name = path.rstrip("/").split("/")[-1] if path != "/" else ""
            out.append(
                {
                    "id": fid,
                    "path": path,
                    "name": name,
                    "title": ext.get("title") or item.get("title") or name or path,
                    "parent": ext.get("parent") or None,
                }
            )
        # de-dupe by id
        seen: set[str] = set()
        uniq: list[dict[str, Any]] = []
        for f in out:
            if f["id"] in seen:
                continue
            seen.add(f["id"])
            uniq.append(f)
        return uniq

    async def create_folder(
        self,
        name: str,
        *,
        title: str = "",
        parent: str = "/",
    ) -> dict[str, Any]:
        slug = (name or "").strip().strip("/")
        if not slug or "/" in slug or not slug.replace("_", "").replace("-", "").isalnum():
            raise ValueError("folder name must be alphanumeric (dash/underscore ok)")
        body = {
            "name": slug,
            "title": (title or slug).strip(),
            "parent": parent if parent.startswith("/") else f"/{parent}",
            "attributes": {},
        }
        resp = await self._request(
            "POST",
            "/domain-types/folder_config/collections/all",
            json=body,
        )
        if resp.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"{resp.status_code} create folder: {resp.text[:500]}",
                request=resp.request,
                response=resp,
            )
        data = resp.json()
        fid = data.get("id") or folder_path_to_id(f"{body['parent'].rstrip('/')}/{slug}")
        return {
            "id": fid,
            "path": folder_id_to_path(fid),
            "name": slug,
            "title": body["title"],
            "parent": body["parent"],
        }

    async def update_folder(self, folder_id: str, *, title: str) -> dict[str, Any]:
        fid = folder_id if folder_id.startswith("~") else folder_path_to_id(folder_id)
        if fid == "~":
            raise ValueError("root folder title cannot be changed")
        resp = await self._request(
            "PUT",
            f"/objects/folder_config/{quote(fid, safe='')}",
            json={"title": title},
            headers={"If-Match": "*"},
        )
        if resp.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"{resp.status_code} update folder: {resp.text[:500]}",
                request=resp.request,
                response=resp,
            )
        return {"id": fid, "path": folder_id_to_path(fid), "title": title}

    async def delete_folder(self, folder_id: str) -> None:
        fid = folder_id if folder_id.startswith("~") else folder_path_to_id(folder_id)
        if fid == "~":
            raise ValueError("cannot delete root folder")
        resp = await self._request("DELETE", f"/objects/folder_config/{quote(fid, safe='')}")
        if resp.status_code not in (200, 204, 404):
            raise httpx.HTTPStatusError(
                f"{resp.status_code} delete folder: {resp.text[:500]}",
                request=resp.request,
                response=resp,
            )

    # ---------- hosts ----------
    async def list_hosts(self) -> list[dict[str, Any]]:
        resp = await self._request(
            "GET",
            "/domain-types/host_config/collections/all",
            params={"effective_attributes": "false"},
        )
        resp.raise_for_status()
        out: list[dict[str, Any]] = []
        for item in resp.json().get("value", []):
            ext = item.get("extensions", {}) or {}
            attrs = ext.get("attributes", {}) or {}
            folder = ext.get("folder") or "/"
            out.append(
                {
                    "name": item.get("id"),
                    "address": attrs.get("ipaddress", ""),
                    "type": "snmp" if attrs.get("tag_snmp_ds") else "agent",
                    "folder": folder if str(folder).startswith("/") else folder_id_to_path(str(folder)),
                    "site_path": folder if str(folder).startswith("/") else folder_id_to_path(str(folder)),
                    "state": "up",
                    "services": 0,
                    "alias": attrs.get("alias", ""),
                }
            )
        return out

    async def get_host(self, name: str) -> dict[str, Any] | None:
        resp = await self._request("GET", f"/objects/host_config/{quote(name, safe='')}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        item = resp.json()
        ext = item.get("extensions", {}) or {}
        attrs = ext.get("attributes", {}) or {}
        folder = ext.get("folder") or "/"
        return {
            "name": item.get("id"),
            "address": attrs.get("ipaddress", ""),
            "type": "snmp" if attrs.get("tag_snmp_ds") else "agent",
            "folder": folder if str(folder).startswith("/") else folder_id_to_path(str(folder)),
            "alias": attrs.get("alias", ""),
            "attributes": attrs,
            "etag": resp.headers.get("ETag") or resp.headers.get("etag") or "*",
        }

    async def create_host(
        self,
        name: str,
        address: str,
        *,
        folder: str = "/",
        snmp_community: str | None = None,
        alias: str = "",
    ) -> dict[str, Any]:
        attributes: dict[str, Any] = {}
        if address:
            attributes["ipaddress"] = address
        if alias:
            attributes["alias"] = alias
        if snmp_community:
            attributes["tag_agent"] = "no-agent"
            attributes["tag_snmp_ds"] = "snmp-v2"
            attributes["snmp_community"] = snmp_community
        body = {
            "folder": folder if folder.startswith("/") else f"/{folder}",
            "host_name": name,
            "attributes": attributes,
        }
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

    async def update_host(
        self,
        name: str,
        *,
        address: str | None = None,
        alias: str | None = None,
        snmp_community: str | None = None,
        host_type: str | None = None,
    ) -> dict[str, Any]:
        update: dict[str, Any] = {}
        if address is not None:
            update["ipaddress"] = address
        if alias is not None:
            update["alias"] = alias
        if host_type == "snmp":
            update["tag_agent"] = "no-agent"
            update["tag_snmp_ds"] = "snmp-v2"
            if snmp_community:
                update["snmp_community"] = snmp_community
        elif host_type == "agent":
            update["tag_agent"] = "cmk-agent"
            update["tag_snmp_ds"] = "no-snmp"
        if not update:
            return {"host": name, "updated": False}
        resp = await self._request(
            "PUT",
            f"/objects/host_config/{quote(name, safe='')}",
            json={"update_attributes": update},
            headers={"If-Match": "*"},
        )
        if resp.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"{resp.status_code} update host: {resp.text[:500]}",
                request=resp.request,
                response=resp,
            )
        return {"host": name, "updated": True, "attributes": update}

    async def move_host(self, name: str, target_folder: str) -> dict[str, Any]:
        folder = target_folder if target_folder.startswith("/") else f"/{target_folder}"
        resp = await self._request(
            "POST",
            f"/objects/host_config/{quote(name, safe='')}/actions/move/invoke",
            json={"target_folder": folder},
            headers={"If-Match": "*"},
        )
        if resp.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"{resp.status_code} move host: {resp.text[:500]}",
                request=resp.request,
                response=resp,
            )
        return {"host": name, "folder": folder}

    async def delete_host(self, name: str) -> None:
        resp = await self._request("DELETE", f"/objects/host_config/{quote(name, safe='')}")
        if resp.status_code not in (204, 200, 404):
            resp.raise_for_status()

    async def discover_services(self, name: str) -> dict[str, Any]:
        body = {"host_name": name, "mode": "refresh"}
        resp = await self._request(
            "POST",
            "/domain-types/service_discovery_run/actions/start/invoke",
            json=body,
        )
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
        self,
        name: str,
        address: str,
        *,
        snmp_community: str | None = None,
        folder: str = "/",
        alias: str = "",
    ) -> dict[str, Any]:
        """Create host → discover services → activate changes (auto-add flow)."""
        created = await self.create_host(
            name, address, folder=folder, snmp_community=snmp_community, alias=alias
        )
        try:
            await self.discover_services(name)
        except httpx.HTTPError:
            pass
        await self.activate_changes()
        return {
            "host": name,
            "activated": True,
            "exists": bool(created.get("exists")),
            "folder": folder,
        }
