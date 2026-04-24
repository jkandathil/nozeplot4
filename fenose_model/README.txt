FeNOse model JSON (local developer use only)

The hosted app does not ship model weights. Inference uses models you train in the app
or upload into the browser workspace folder "Model/" (see ML Studio → Inference).

Developers can still export JSON here for local Vite testing if you run a build that
loads from static files — those files are gitignored under public/fenose_model/v1/ and v2/:

  public/fenose_model/v1/weights.json
  public/fenose_model/v1/preprocessing.json
  (and similarly v2/)

Run scripts/exportFenoseNpzsToPublic.mjs after placing source artifacts to regenerate.

Expected JSON shapes are documented in the project’s FeNOse tooling / fenose_predict.py.

Notes:
- Captures need event_name phases (e.g. AmbientSamplingRFC, FeNOMeasurement) and sensor A1–H8.
