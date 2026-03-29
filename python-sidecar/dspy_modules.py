from __future__ import annotations

"""
Legacy compatibility shim.

Older sidecar revisions imported `MarketingAnalyzerModule` from this file.
The new Helena runtime does not depend on DSPy, but we keep this class so
historical scripts do not break.
"""


class MarketingAnalyzerModule:
    def __call__(self, project_context: str, market_signals: str) -> str:
        return self.forward(project_context=project_context, market_signals=market_signals)

    def forward(self, project_context: str, market_signals: str) -> str:
        return (
            "Helena fallback assessment: compare project context to trend data, "
            "prioritize one pipeline action and one delivery-risk mitigation action in 7 days."
        )
