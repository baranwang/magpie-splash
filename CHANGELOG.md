# Changelog

## 0.1.0

- Detect local-path CLI support before starting Splash; installed versions without it use the model ID in offline mode.
- Discover installed Splash assemblies from disk and refresh the provider catalog without starting inference.
- Route requests to the selected local model, draining active streams before switching processes.
- Enable managed local Splash without asking for an API key, using Magpie's keyless authorization method.
- Add a Magpie/OpenCode Splash provider with lazy startup, shared requests and stream-aware idle shutdown.
- Supervise owned process groups across host exit, including SIGKILL; allow externally managed services without taking process ownership.
- Configure model, context, vision, memory arguments and startup/idle deadlines.
