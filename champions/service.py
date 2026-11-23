"""One place that answers a capability request and logs it, whichever door
it came through (A2A, MCP via the REST API, or REST directly)."""

import time

from champions import matcher, querylog


def answer(request, *, log, channel, client):
    started = time.perf_counter()
    result = matcher.answer(request)
    shared = request.context.shared if request.context else {}
    result.gaps = querylog.gaps(request, result.matching_companies)
    result.query_id = log.record(
        request, channel=channel, client=client, shared=shared,
        cards=[m.card_id for m in result.matches],
        insight_ids=[i.id for i in result.insights if i.id],
        matching=result.matching_companies,
        latency_ms=(time.perf_counter() - started) * 1000,
    )
    return result


def feedback(fb, *, log, client):
    """Store ratings on one of ``client``'s own queries; how many were recorded, or None."""

    ratings = {r.insight_id: r.useful for r in fb.ratings}
    return len(ratings) if log.add_feedback(fb.query_id, ratings, client=client) else None
