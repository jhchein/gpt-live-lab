# Voice conversation demo

The demo combines a live voice conversation with delegated reasoning and optional web research.

## Language

**Voice session**:
A live conversation in which the user and the voice model can listen and speak in both directions. Delegated work may continue while the conversation remains open.

**Delegation**:
A request from the voice model for the application to perform work. A delegation can wait in a queue, become active, and contain multiple reasoning steps and searches.

**Reasoning step**:
One model request and its response within a delegation. A step may produce answer text or request a search before another step continues the work.

**Search attempt**:
One dispatched request to the web search provider. A retry is another attempt at the same search, not another delegation.

**Observation state**:
The application's current account of the voice session and delegated work, used to explain the same activity consistently across views. It describes execution without controlling it and is distinct from the retained event history.

**Cost estimate**:
A calculation from configured rates and observed or estimated usage. It may be incomplete or provisional and is not a provider invoice.
