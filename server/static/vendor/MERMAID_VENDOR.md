# Vendored mermaid

| Field | Value |
|---|---|
| Package | `mermaid` |
| Version | `10.9.1` |
| Source URL | https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js |
| sha256 | `61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6` |
| Size | 3,335,717 bytes |
| Vendored on | 2026-05-07 |

## Why v10.9.1

v10.x is the last major with broad ecosystem stability and the
`agentic-bridge` palette was developed against v10's flowchart
renderer. v11 introduced layout-engine swaps that risk visual
regression for the diagrams this plugin emits.

## Verification

```bash
shasum -a 256 server/static/vendor/mermaid.min.js | awk '{print $1}'
# expect: 61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6
```

**The vendored file is byte-identical to the upstream artifact** so the
hash check above continues to match. Do NOT prepend metadata into
`mermaid.min.js` itself — that would break the integrity check. All
provenance metadata lives in this sidecar file.

## On hash mismatch

If `shasum -c` ever fails:

1. **Do NOT modify the expected hash to silence the failure.**
2. Investigate. The upstream artifact may have been republished, or
   the network path tampered with. Either case warrants escalation,
   not a hash overwrite.
3. If upstream legitimately changed (e.g. a 10.9.2 patch release),
   re-vendor explicitly: pin the new version, fetch, verify against
   the new published hash, update this file with new hash + version.

## License

mermaid is MIT licensed — see https://github.com/mermaid-js/mermaid/blob/develop/LICENSE
