# pi-requesty-discover

This extension helps you to discover currently available models in requesty.ai for your Pi Coding Agent.

this is a fork of [pi-requesty](https://github.com/requestyai/pi-requesty) with additional features

- use `REQUESTY_API_KEY` from the environment
- health check available models and write a log about them
- make a dry-run that does not change anything

## (Recommended) Install from GitHub Repo

```bash
pi install git:github.com/enolive/pi-requesty-export
```

## Install locally

Check out the code from the official code repository `https://github.com/enolive/pi-requesty-discover`, and then:

```bash
pi install ./pi-requesty-discover
```

To run once without installing:

```bash
pi -e ./pi-requesty-discover
```

## Configuration

The extension only reads the `requesty-export` provider from `~/.pi/agent/models.json`. You can override its name by
setting up
the `REQUESTY_PROVIDER_ID` variable.

Example:

```json
{
  "providers": {
    "requesty-export": {
      "name": "Requesty",
      "baseUrl": "https://router.requesty.ai/v1",
      "apiKey": "rqsty-sk-...",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

If your `models.json` is getting the apiKey from an environment variable, you won't be able to obtain it for this
plugin. Set the `REQUESTY_API_KEY` variable instead.

On startup, the extension fetches `<baseUrl>/models` using `apiKey` as the bearer token and registers discovered models
with pi.

### Environment variables

| name                       | type                             | default           | meaning                               |
|----------------------------|----------------------------------|-------------------|---------------------------------------|
| REQUESTY_API_KEY           | `string`                         |                   | override the apiKey set in the config |
| REQUESTY_PROVIDER_ID       | `string`                         | `requesty-export` | the id of the provider.               | 
| REQUESTY_HEALTH_CHECK_MODE | `off` <br/> `basic` <br/> `full` | `full`            | the health check mode.                | 

## Command

Inside pi:

```text
/requesty-discover
```

The command fetches Requesty models using `~/.pi/agent/models.json` and writes the discovered model IDs back to the same
file. Run `/reload` after syncing.

```text
/requesty-discover --dry-run
```

will not overwrite the `models.json` file, but do anything else, including the health checks.
