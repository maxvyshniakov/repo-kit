# Domain

[README](../../README.md) defines configuration and command contracts: verify is
repository validation; pre-push validates exact outgoing commits; release cuts a
version; release-gate verifies and attests an exact release revision; publish
uploads that already released package. A consumer is a repository using the kit.
Slots budget machine execution; lanes belong to project orchestration.

Shared command changes preserve all documented consumer behavior unless an
explicit breaking change is recorded in CHANGELOG.md. Version and changelog
policy: [README versioning](../../README.md#versioning).
