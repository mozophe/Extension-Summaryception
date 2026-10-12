# Non-Chat-Completion (Text Completion) Connections

Summaryception targets chat-completion framing for its summarizer and auditor calls. On text-completion connections (koboldcpp, ooba, llama.cpp, and friends), correct request framing is the user's SillyTavern configuration responsibility, not something the extension detects, compensates for, or supports.

## Why this is out of scope

The failure signature of a mis-framed text-completion call is easy to recognize: the model receives the summarizer prompt as one bare instruction document (SillyTavern ships Instruct Mode OFF, and with it off the host flattens the whole request into a single continuation text) and responds by continuing or echoing the instruction blocks instead of answering them. The integrity validator correctly rejects that output as `missing <narrative> envelope`, retries exhaust, nothing is stored.

Building extension-side resilience for this would mean duplicating the host's Instruct Mode logic inside the extension, or shipping an echo/parroting detector that guesses at model pathology — both fragile, both redundant with a feature SillyTavern already owns. The supported path is configuration:

1. Enable Instruct Mode (the "A" toolbar toggle; ships OFF on fresh installs).
2. Set the Instruct Template to match the loaded model (Gemma template for Gemma-family, ChatML for Qwen-family; the template is per-connection, so switch it with the model). The factory-default Alpaca template fits neither.
3. If the echo persists with correct framing, the model itself is the limit — heavily modified community finetunes at aggressive quants routinely lose instruction-following; test a stock instruct build.

Model choice and local sampler tuning are likewise the user's side of the boundary. Verified by maintainer A/B (#43): identical prompt and extension code succeed on every passage over chat completion while the reporter's unframed text-completion setup echoed the prompt back.

## Prior requests

- #43: "Summarizer response failed integrity validation: missing <narrative envelope" (koboldcpp, Instruct Mode off, prompt echo)
