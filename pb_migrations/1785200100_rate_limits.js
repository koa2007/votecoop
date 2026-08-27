/// <reference path="../pb_data/types.d.ts" />

// These rules lived only in the production database. A server rebuilt from this
// repository — which `tests/README.md` and the bootstrap hook both describe as a
// supported thing to do — came up with no rate limiting at all, and rate limiting is
// the only thing standing between a six-digit house code and an unlimited stream of
// guesses. Also adds a limit for submit-join, which had none of its own: with a house
// code in hand, that route answers "this flat is taken" per apartment, which maps out
// which flats have a registered voting resident.
migrate(
  (app) => {
    const s = app.settings();
    const wanted = [
      { label: "*:auth", audience: "", duration: 5, maxRequests: 5 },
      { label: "*:create", audience: "", duration: 5, maxRequests: 20 },
      { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
      {
        label: "/api/spilka/find-group",
        audience: "",
        duration: 60,
        maxRequests: 15,
      },
      {
        label: "/api/spilka/submit-join",
        audience: "",
        duration: 60,
        maxRequests: 10,
      },
      {
        label: "/api/spilka/broadcast",
        audience: "",
        duration: 60,
        maxRequests: 10,
      },
      { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
    ];
    s.rateLimits.enabled = true;
    s.rateLimits.rules = wanted;
    app.save(s);
  },
  (app) => {
    // Down: leave the limits in place. Removing them would open the door this
    // migration exists to keep shut, and nothing depends on their absence.
  },
);
