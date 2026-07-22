# Third-party notices

This file records material incorporated into the AliasHub source distribution.
It is informational and does not replace the applicable license terms.

## FrciblyK12-derived registration worker

The source under `registration-worker/` is a modified derivative of
[FrciblyK12](https://github.com/sky3100/FrciblyK12), based on upstream commit
`6ad0e1e8dd889f9eb023dae25511cc58ce2caf2a`. Copyright in the upstream work
remains with the FrciblyK12 contributors.

FrciblyK12 is distributed under the GNU Affero General Public License version 3.
The worker's license text is retained at `registration-worker/LICENSE`, its
provenance is recorded in `registration-worker/UPSTREAM.md`, and its complete
modified source is included in `registration-worker/`.

The upstream FrciblyK12 README also credits the plugin architecture of
`lxf746/any-auto-register`. AliasHub is derived from the pinned FrciblyK12
baseline rather than directly from that earlier repository; the upstream credit
is preserved in `registration-worker/README.md`.

## iCloud Mail parsing dependencies

AliasHub uses [ImapFlow](https://imapflow.com/) under the MIT License to connect
to iCloud Mail over IMAP, and [PostalMime](https://postal-mime.postalsys.com/)
under the MIT No Attribution License (MIT-0) to parse bounded RFC 822 message
content. Their source and license information are available from the linked
projects and installed package metadata.

## AliasHub license

AliasHub's original project code and this combined source distribution are
released under `AGPL-3.0-only`; see the root `LICENSE` file. Copyrights and
licenses for third-party dependencies remain with their respective holders.
