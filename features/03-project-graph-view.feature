Feature: Project Graph View
  As a Java developer unfamiliar with a large codebase
  I want an interactive visual graph of class relationships
  So that I can understand project structure and navigate efficiently

  Background:
    Given the Alat extension is active
    And a Java project is open and indexed by the Java Language Server

  Scenario: Open graph view from command palette
    Given any Java file is open in the editor
    When I invoke "Alat: Open Dependency Graph"
    Then a new editor panel opens showing the project graph
    And the graph displays packages as clusters and classes as nodes

  Scenario: Graph shows class inheritance relationships
    Given the project has classes extending other classes
    When the graph is rendered
    Then inheritance relationships are shown as directed edges labeled "extends"
    And the direction flows from subclass to superclass

  Scenario: Graph shows interface implementation relationships
    Given the project has classes implementing interfaces
    When the graph is rendered
    Then implementation relationships are shown as directed edges labeled "implements"

  Scenario: Graph shows dependency relationships
    Given a class "OrderService" has a field of type "PaymentGateway"
    When the graph is rendered
    Then a "uses" edge is shown from "OrderService" to "PaymentGateway"

  Scenario: Navigate to source from a graph node
    Given the project graph is open
    When I double-click on a class node "OrderService"
    Then the editor opens the corresponding Java file
    And the cursor is placed at the class declaration

  Scenario: Filter graph by package
    Given the project graph is open and shows the full project
    When I select a package "com.example.orders" in the filter panel
    Then the graph shows only classes within that package
    And cross-package dependencies to external classes are shown as external nodes

  Scenario: Toggle relationship types visibility
    Given the project graph is open
    When I uncheck "Show Dependencies" in the display options
    Then "uses" edges are hidden
    And only inheritance and implementation edges remain

  Scenario: Search for a node in the graph
    Given the project graph is open
    When I type "Order" in the graph search box
    Then matching nodes are highlighted
    And non-matching nodes are dimmed

  Scenario: Graph loads incrementally for large projects
    Given a project with more than 200 classes
    When I open the project graph
    Then the graph initially shows the top-level package structure
    And I can expand packages to reveal classes progressively

  Scenario: Graph state is preserved between sessions
    Given I have the graph open with specific filters applied
    When I close and reopen VSCode
    Then the graph reopens with the same filters and zoom level

  Scenario: Export graph as image
    Given the project graph is open
    When I invoke "Export Graph as PNG"
    Then a PNG file is saved to the workspace root
    And a notification confirms the export location
