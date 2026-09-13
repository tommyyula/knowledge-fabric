# Do not refresh dirty repository checkouts

**Status:** Planned future work — not implemented.

An explicit refresh must check the Repository Checkout for uncommitted changes before fetching and checking out the remote branch. If it is dirty, Knowledge Fabric stops and reports the state; it must not automatically discard, stash, or overwrite the changes.
