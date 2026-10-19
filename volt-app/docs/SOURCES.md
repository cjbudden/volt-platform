# Sources for channels and events

Which source types a channel or event can take, what each one needs, and what
the encoder does with it. Code: `volt-app/src/services/ingestProtocols.ts` (the
registry and `validateSource`), `volt-web/src/protocols.tsx` (the form),
`volt-encoder/bin/ingest_args.py` (how ffmpeg opens each one). Tests:
`volt-app/test/source-protocols.check.ts` (31), `volt-encoder/bin/test_ingest_args.py` (17).

## 1. What is offered where

| | Transcode | Packaging (per rendition) | Radio station |
|---|---|---|---|
| HLS | yes | yes, copied | yes |
| DASH | yes | yes, copied | yes |
| SRT | yes | yes, copied | |
| RTMP / RTMPS | yes | yes, copied | |
| NDI | yes | yes, **encoded once** to the rendition | |
| ST 2110 | yes | yes, **encoded once** to the rendition | |
| Icecast / HTTP audio | **no** | **no** | yes |

The same list on New channel, Channel settings and the event drawer (events
now have the packaging rendition rows too). A channel or event saved with
Icecast is refused: "Icecast / HTTP audio is for radio stations".

**Packaging NDI and ST 2110.** They carry uncompressed video, so there is
nothing to re-package: that rendition is encoded once, at its own height and
bitrate, one segment per GOP so it lines up with the others. The row says so.

## 2. What each one needs

| Type | Address | Required | Settings |
|---|---|---|---|
| HLS | playlist URL (`…m3u8`) | the URL | a master asks which variant to take |
| DASH | manifest URL (`…mpd`) | the URL | |
| SRT | `srt://host:port` | the URL with its port | **Connection**: Caller (we connect to the sender's address) or Listener (we open `srt://0.0.0.0:PORT`, the sender connects to our ingest host). **Latency** 20 to 8000 ms (200 typical, 1000+ over the internet). **Passphrase** 10 to 79 characters, with **key length** AES-128/192/256. **Stream ID** when the other side needs one |
| RTMP / RTMPS | server URL `rtmp://host/app` | URL **and stream key** (unless the key is already the last part of the URL) | the key is joined to the URL for the encoder (`rtmp://host/app/KEY`) |
| NDI | source name `MACHINE (Source)` | the name | **Discovery server** (host:port, for discovery across subnets and in the cloud), **groups**, **extra IPs**, full quality or proxy. Needs an NDI-enabled ingest node |
| ST 2110 | video flow `239.x.x.x:port` (multicast) | the flow and the **SDP** (its URL or the SDP text, listing the 2110-20 video and 2110-30 audio flows) | **Receive interface** (the ingest node's IP on the media network), source IP for SSM, PTP domain (default 127). Needs a 2110 ingest node, PTP-locked |

The form shows the common settings and keeps the rest under "More settings";
it says what is missing as you type, and the server refuses the same things
(422, with the reason). Settings are stored with the input
(`stream_inputs.params`, migration 0057) and only the keys the protocol
defines are kept.

**Check source** works for HLS, DASH, SRT in caller mode (with its settings)
and a pulled RTMP URL. A push source (SRT listener, RTMP to us) has nothing to
dial until it sends, and NDI / ST 2110 are only visible on the ingest node's
own network, so those are checked when the stream starts.

## 3. The encoder

`ingest_args.py` builds the ffmpeg input for each type, used by the direct
relays, the transcoder and the failover relays alike:

* **SRT**: the settings become URL options (`mode`, `latency` in microseconds,
  `passphrase`, `pbkeylen`, `streamid`); anything typed into the URL wins.
* **DASH**: reconnects like HLS.
* **NDI**: `-f libndi_newtek`, extra IPs, and an NDI config file for groups and
  the discovery server. An ffmpeg built without the NDI SDK refuses with the
  reason (run an NDI-enabled node, or bridge NDI to SRT).
* **ST 2110**: the SDP is fetched or written to a file and opened over RTP,
  joined on the receive interface.

An ST 2110 source without its SDP cannot start (the start check says so).
