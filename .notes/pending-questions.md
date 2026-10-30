
| ID | Choice made | Reason / follow-up |
|---|---|---|
| T1R-1 | Nullable source list on existing user documents retains legacy include switches and critic-first order; admin/new-user default is Community then Critic. | Preserves upgrade behavior while explicit lists have exact requested order; empty means no source scores. |
| T1R-2 | Minimum score and colour apply to configured source scores; the existing user-review chip remains independent. | Keeps review semantics and missing-review dashes stable. |
| T1R-3 | Legacy Community/Critic compact behavior stays; named-source compact chips use value plus a 2px source dot. | Preserves existing layouts and changes only the added chips. |
| T1R-4 | Reuse TMDb identifiers through the existing MDBList batch API; items with only IMDb ids do not trigger a second upstream lookup path. | The brief permits IMDb/TMDb keys; existing JE service is TMDb keyed and shares caching/quota across consumers. |
| T1R-5 | Assigned clone has an empty MDBList key; private key request timed out. | No-key output and UI preview verified. Live upstream fetching and source-filled desktop/420 movie-grid screenshots remain unverified. |
