import ipaddress
import json
import os
import socket
from urllib.parse import urlsplit

from yt_dlp import YoutubeDL


def _validate_public_url(raw):
    value = (raw or "").strip()
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Enter a public HTTPS media link.")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Private and local network links are not supported.")
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global:
            raise ValueError("Private and local network links are not supported.")
    except ValueError as error:
        if "Private and local" in str(error):
            raise
        try:
            results = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError:
            results = []
        if not results or any(not ipaddress.ip_address(item[4][0]).is_global for item in results):
            raise ValueError("Private, local, or unresolved links are not supported.")
    return value


def _public_format(item):
    video = item.get("vcodec") not in (None, "none")
    audio = item.get("acodec") not in (None, "none")
    return video and audio or audio and not video


def _format_label(item):
    if item.get("vcodec") in (None, "none"):
        return "Audio · {} · {}".format(item.get("ext", "file").upper(), item.get("abr") or "audio")
    height = item.get("height")
    quality = "{}p".format(height) if height else item.get("format_note") or "Video"
    return "{} · {} · {}".format(quality, item.get("ext", "file").upper(), "audio included")


def analyze(raw_url):
    url = _validate_public_url(raw_url)
    options = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True, "ignoreerrors": False}
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise ValueError("This link did not return a media item.")
    formats = []
    for item in info.get("formats") or []:
        if not item.get("format_id") or not _public_format(item):
            continue
        size = item.get("filesize") or item.get("filesize_approx")
        formats.append({
            "id": str(item["format_id"]),
            "label": _format_label(item),
            "ext": item.get("ext", "mp4"),
            "height": item.get("height") or 0,
            "audioOnly": item.get("vcodec") in (None, "none"),
            "size": size,
        })
    formats.sort(key=lambda item: (item["audioOnly"], -item["height"], item["ext"] != "mp4"))
    return json.dumps({
        "title": info.get("title") or "Untitled media",
        "source": info.get("extractor_key") or info.get("extractor") or "Media source",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "formats": formats[:40],
    })


def download(raw_url, format_id, output_dir):
    url = _validate_public_url(raw_url)
    os.makedirs(output_dir, exist_ok=True)
    options = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": str(format_id),
        "outtmpl": os.path.join(output_dir, "%(title).120B.%(ext)s"),
        "overwrites": True,
        "continuedl": True,
    }
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)
        path = ydl.prepare_filename(info)
    if not os.path.isfile(path):
        raise ValueError("The source did not create a downloadable file.")
    return json.dumps({"path": path, "title": info.get("title") or "Xovra download", "ext": info.get("ext") or "mp4"})

