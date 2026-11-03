import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import storage


@pytest.fixture
def client(tmp_path, monkeypatch):
    test_db = tmp_path / "test_spark.db"
    monkeypatch.setattr(storage, "DB_PATH", test_db)
    storage.initialize()
    with TestClient(app) as test_client:
        yield test_client


def test_metrics_endpoint(client):
    res = client.get("/api/metrics")
    assert res.status_code == 200
    data = res.json()
    assert "total_discovered" in data
    assert "saved_leads" in data
    assert "missing_website" in data


def test_lead_lifecycle(client):
    lead_payload = {
        "id": "lead_123",
        "name": "Apex Roofing Solutions",
        "category": "Roofing contractor",
        "phone": "+1 608-555-0199",
        "address": "123 Main St, Madison, WI",
        "website": "",
        "website_status": "missing",
        "rating": 4.9,
        "reviews": 38,
        "is_claimed": True,
        "status": "New",
        "list_name": "General",
        "notes": "Spoke with owner",
        "tags": ["high-value", "roofing"]
    }
    # 1. Save lead
    post_res = client.post("/api/leads", json=lead_payload)
    assert post_res.status_code == 200
    saved = post_res.json()["lead"]
    assert saved["name"] == "Apex Roofing Solutions"
    assert saved["status"] == "New"

    # 2. Get leads
    get_res = client.get("/api/leads")
    assert get_res.status_code == 200
    leads = get_res.json()["leads"]
    assert len(leads) == 1
    assert leads[0]["id"] == "lead_123"

    # 3. Update lead status to 'Qualified'
    patch_res = client.patch("/api/leads/lead_123", json={"status": "Qualified", "notes": "Interested in new website"})
    assert patch_res.status_code == 200
    updated = patch_res.json()["lead"]
    assert updated["status"] == "Qualified"
    assert updated["notes"] == "Interested in new website"

    # 4. Filter by status
    filter_res = client.get("/api/leads?status=Qualified")
    assert filter_res.status_code == 200
    assert len(filter_res.json()["leads"]) == 1

    empty_res = client.get("/api/leads?status=Rejected")
    assert len(empty_res.json()["leads"]) == 0

    # 5. Delete lead
    del_res = client.delete("/api/leads/lead_123")
    assert del_res.status_code == 200
    assert len(client.get("/api/leads").json()["leads"]) == 0


def test_lists_crud(client):
    # 1. Default list exists
    res = client.get("/api/lists")
    assert res.status_code == 200
    lists = res.json()["lists"]
    assert any(l["name"] == "General" for l in lists)

    # 2. Create custom list
    create_res = client.post("/api/lists", json={"name": "Hansi Electricians Campaign", "description": "Local outreach"})
    assert create_res.status_code == 200
    assert create_res.json()["list"]["name"] == "Hansi Electricians Campaign"

    # 3. Delete custom list
    del_res = client.delete("/api/lists/Hansi Electricians Campaign")
    assert del_res.status_code == 200

    # 4. Cannot delete General list
    fail_del = client.delete("/api/lists/General")
    assert fail_del.status_code == 400
