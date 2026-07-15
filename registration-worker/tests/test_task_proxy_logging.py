from application.tasks import _mask_proxy_for_log


def test_registration_proxy_log_masks_credentials():
    assert (
        _mask_proxy_for_log("http://user:secret@proxy.example:8080")
        == "http://***@proxy.example:8080"
    )
    assert _mask_proxy_for_log("socks5://proxy.example:1080") == "socks5://proxy.example:1080"


def test_registration_proxy_log_hides_malformed_userinfo_entirely():
    masked = _mask_proxy_for_log(
        "http://proxy-user:super-secret＠proxy.example:8080"
    )

    assert masked == "<invalid-proxy>"
    assert "proxy-user" not in masked
    assert "super-secret" not in masked
