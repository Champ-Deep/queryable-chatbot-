"""One TLS context for every httpx client.

Building an httpx client loads the CA bundle, which costs about 0.4 s on
Windows. The agents open several short-lived clients per conversation, so
they share this context instead of rebuilding it each time.
"""

import functools
import ssl

import certifi


@functools.cache
def tls_context():
    return ssl.create_default_context(cafile=certifi.where())
