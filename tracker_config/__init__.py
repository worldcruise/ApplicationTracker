"""JSON configuration boundaries; importing this package never loads user data."""

from .models import (
    ConfigurationError, RevisionConflict, empty_catalog, empty_profile, empty_registry,
    migrate_candidate_registry, validate_candidate_registry, validate_document_catalog,
    validate_profile, validate_prompt_catalog, validate_template_references,
)
from .repositories import (
    CandidateRegistryRepository, ConfigurationRepositories, DocumentTemplateRepository,
    JsonRepository, ProfileRepository, PromptTemplateRepository, Snapshot, atomic_write_text,
)

__all__ = [
    "ConfigurationError", "RevisionConflict", "empty_catalog", "empty_profile", "empty_registry",
    "migrate_candidate_registry", "validate_candidate_registry", "validate_document_catalog",
    "validate_profile", "validate_prompt_catalog", "validate_template_references",
    "CandidateRegistryRepository", "ConfigurationRepositories", "DocumentTemplateRepository",
    "JsonRepository", "ProfileRepository", "PromptTemplateRepository", "Snapshot", "atomic_write_text",
]
