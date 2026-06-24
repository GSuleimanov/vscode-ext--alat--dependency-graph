Feature: Filtered peek behaviour per token
  Drives the real extension against the sample Java project (test-fixtures/gomatch-sample)
  with the Java language server, asserting the structured outcome of "Peek References
  (Filtered)" for representative tokens. These lock current behaviour and are the surface
  for experimenting with the peek algorithm.

  Background:
    Given the sample project is open and the Java language server is ready

  Scenario: Peeking a project type lists it under Type Definitions
    When I peek references on "ProfileRepository" in "repo/ProfileRepository.java"
    Then the peek succeeds
    And the "typeDefinition" section includes "repo/ProfileRepository.java"

  Scenario: Peeking an injected field surfaces the type and cross-class usages
    When I peek references on "profileRepository" in "service/ProfileService.java"
    Then the peek succeeds
    And the "typeDefinition" section includes "repo/ProfileRepository.java"
    And the "definition" section includes "service/CoachService.java"
    And the "reference" section includes "service/CoachService.java"

  Scenario: Peeking an inherited JPA method scopes to this repository's usages
    When I peek references on "findById" in "service/ProfileService.java"
    Then the peek succeeds
    And the "typeDefinition" section includes "repo/ProfileRepository.java"
    And the "reference" section includes "service/ProfileService.java"
    And the "reference" section includes "service/CoachService.java"

  Scenario: Peeking a JDK type is refused (guardrail, no search)
    When I peek references on "String" in "domain/Profile.java"
    Then the peek is refused

  Scenario: Peeking a project method finds its callers
    When I peek references on "getCoachInfo" in "service/ProfileService.java"
    Then the peek succeeds
    And the "reference" section includes "service/CoachService.java"

  Scenario: A method that returns the type is not a definition of it
    When I peek references on "Profile" in "repo/ProfileRepository.java"
    Then the peek succeeds
    And the "definition" section does not include "service/ProfileService.java"
