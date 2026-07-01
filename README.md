# pi-requesty (Official Requesty extension for Pi)

The official Requesty extension for the Pi Coding Agent

## (Recommended) Install from Github Repo

```bash
pi install git:github.com/requestyai/pi-requesty@c28e2f8
```

NOTE: Version c28e2f8 points to out latest v0.2.7 version, and keeps you safe from supply chain attack.

## Install locally

Check out the code from the official code repository `https://github.com/requestyai/pi-requesty`, and then:

```bash
pi install ./pi-requesty
```

To run once without installing:

```bash
pi -e ./pi-requesty
```

## Configuration

The extension only reads the `requesty` provider from `~/.pi/agent/models.json`. You can override this by setting up the `REQUESTY_PROVIDER_ID` variable.

Example:

```json
{
  "providers": {
    "requesty": {
      "name": "Requesty",
      "baseUrl": "https://router.requesty.ai/v1",
      "apiKey": "rqsty-sk-...",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

On startup, the extension fetches `<baseUrl>/models` using `apiKey` as the bearer token and registers discovered models with pi.


### Environment variables

| name | meaning |
| ---- | ------- |
| REQUESTY_API_KEY | define an api key for accessing requesty. This will override the configfured api key in the providers configuration which won't work if you use environment variables or shell integration here |
| REQUESTY_PROVIDER_ID | the id of the provider. Defaults to `requesty` which might be bad as pi already populates this with all default models | 

## Command

Inside pi:

```text
/requesty-models-sync
```

The command fetches Requesty models using `~/.pi/agent/models.json` and writes the discovered model IDs back to the same file.
Run `/reload` after syncing.
