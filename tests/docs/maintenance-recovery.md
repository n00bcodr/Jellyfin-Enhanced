# Maintenance recovery regression contract

`tests/backend/Core/CoreMaintenanceTests.cs` exercises the actual maintenance service against a disposable state directory and a mocked Jellyfin policy store. Policy copies model independent persisted reads, so a failed update cannot accidentally mutate the test store.

The suite verifies that administrators and previously restricted users keep their original access, only successful maintenance changes enter restoration lists, and failed restores remain pending across restart. Each successfully restored user is removed from the journal; retries do not change that user's later administrator-set restrictions. Reconciliation becomes inactive while restoration is pending, and cannot replace unresolved restoration intent with a new selection. Null persisted lists are normalized. Failed journal writes are observable, use an atomic replacement, and do not silently change the cached state.

These tests do **not** establish a transaction across Jellyfin's policy database and JE's journal file. A process failure between a committed policy update and its journal checkpoint, a policy backend that commits and then throws, or administrator changes to a still-pending user's same permission remain ambiguous. The two stores do not expose a shared transaction or policy revision check. Recovery retries are covered for policy operations that fail before committing and for successful checkpoints; crash-exactly-between-stores and after-commit exceptions remain explicit limitations.

Real Jellyfin host tests separately exercise loading and HTTP behavior. Maintenance policy failure injection here uses mocked host interfaces rather than a real database outage.
