# Reuse repository checkouts until explicitly refreshed

**Status:** Planned future work — not implemented.

The first reference to a Bitbucket Repository Reference creates its Repository Checkout in the target ontology workspace. Later references reuse that checkout unchanged; fetching and checking out the selected branch's latest commit requires an explicit refresh so a knowledge base's source material does not change as a side effect of a chat reference.
