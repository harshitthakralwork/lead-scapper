import pytest
from pydantic import ValidationError

from app.main import SearchInput, result_view
from app.scraper import clean_label, clean_maps_url, extract_business, normalize_name, parse_rating, parse_reviews, place_key, public_http_url
from app import storage


def test_rating_parsing():
    assert parse_rating('4.7') == 4.7
    assert parse_rating('4,7 stars') == 4.7
    assert parse_rating('') is None
    assert parse_rating('7.0') is None


def test_review_parsing():
    assert parse_reviews('1,234 reviews') == 1234
    assert parse_reviews('1 review') == 1
    assert parse_reviews('(42)') == 42
    assert parse_reviews('4.7 stars 11 Reviews') == 11
    assert parse_reviews('Write a review') is None
    assert parse_reviews('') is None


def test_label_cleanup():
    assert clean_label('Phone: (608) 123-4567', 'Phone') == '(608) 123-4567'
    assert clean_label('Address: 1 Main St', 'Address') == '1 Main St'
    assert clean_label('', 'Phone') == ''


def test_place_dedup_ignores_coordinates_and_tracking():
    a = 'https://www.google.com/maps/place/Example/data=!4m5!1s0x123:0xABC!3d10!4d20?g_ep=one'
    b = 'https://www.google.com/maps/place/Example/data=!4m5!1s0x123:0xabc!3d30!4d40?g_ep=two'
    assert place_key(a) == place_key(b) == '0x123:0xabc'


def test_public_url_rejects_script():
    assert public_http_url('javascript:alert(1)') == ''
    assert public_http_url('https://example.com') == 'https://example.com'


def test_maps_url_removes_tracking_but_keeps_place_data():
    url = 'https://www.google.com/maps/place/Test/data=!4m2!1s0x1:0x2!19sABC?authuser=0&hl=en&g_ep=secret&rclk=1'
    assert clean_maps_url(url) == 'https://www.google.com/maps/place/Test/data=!4m2!1s0x1:0x2!19sABC?hl=en'


def test_unknown_is_not_missing():
    listing = {'name': 'Example Plumbing', 'url': 'https://www.google.com/maps/place/test'}
    unknown = extract_business(listing, {'name': 'Example Plumbing', 'profile_ready': False}, listing['url'])
    assert unknown['website_status'] == 'unknown'
    missing = extract_business(listing, {'name': 'Example Plumbing', 'profile_ready': True}, listing['url'])
    assert missing['website_status'] == 'missing'
    linked = extract_business(listing, {'name': 'Example Plumbing', 'profile_ready': True, 'website': 'https://example.com'}, listing['url'])
    assert linked['website_status'] == 'linked'


def test_wrong_profile_is_rejected():
    listing = {'name': 'Expected business'}
    assert extract_business(listing, {'name': 'Results', 'profile_ready': True}, 'https://www.google.com/maps/place/x') is None


def make_business(name, website):
    return extract_business({'name': name}, {'name': name, 'website': website, 'profile_ready': True}, f'https://www.google.com/maps/place/{name}')


def test_payload_keeps_all_rows_for_client_filtering():
    data = {'businesses': [make_business('A', ''), make_business('B', 'https://example.com')]}
    view = result_view(data, True)
    assert len(view['businesses']) == 2  # Changing the UI filter must not need a new search.
    assert view['only_missing'] is True
    assert view['inspected'] == 2
    assert view['missing'] == 1
    assert view['with_website'] == 1
    assert result_view(data, False)['only_missing'] is False


def test_search_validation():
    with pytest.raises(ValidationError):
        SearchInput(niche='   ', city='Madison')
    with pytest.raises(ValidationError):
        SearchInput(niche='Plumbers', city='Madison', limit=500)
    assert SearchInput(niche='  Plumbers ', city='Madison, WI').niche == 'Plumbers'


def test_cache_roundtrip_and_reuse(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, 'DB_PATH', tmp_path / 'test.db')
    storage.initialize()
    payload = {'niche': 'Plumbers', 'city': 'Madison, WI', 'businesses': [make_business('A', ''), make_business('B', 'https://example.com')], 'complete': True}
    storage.put_cached('Plumbers', 'Madison, WI', 20, payload)
    assert storage.get_cached(' plumbers ', 'Madison, WI', 10)['inspected'] == 2
    cached = storage.get_cached('plumbers', 'madison, wi', 20)
    assert cached['cached'] is True
    assert len(cached['businesses']) == 2
    assert storage.get_cached('plumbers', 'Nanaimo', 20) is None
    assert len(storage.recent_searches()) == 1


def test_atomic_quota(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, 'DB_PATH', tmp_path / 'quota.db')
    monkeypatch.setattr(storage, 'FRESH_SEARCH_LIMIT', 2)
    storage.initialize()
    assert storage.reserve_search('a', 'Plumbers', 'Madison')
    assert storage.reserve_search('b', 'Dentists', 'Austin')
    assert not storage.reserve_search('c', 'Roofers', 'Dallas')
    assert storage.usage_count() == 2
