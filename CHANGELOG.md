# Changelog

All notable changes to Voice.Assembly.FM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2025-01-15

### Added

- **HRG (Harmonic Ratio Generator) system** for frequency parameters
  - SIN (Stochastic Integer Notation) parsing: "1-3,5,7-9" → [1,2,3,5,7,8,9]
  - Temporal behaviors with progression at EOC (End of Cycle) boundaries:
    - Static (S): Random start, constant value
    - Ascending (A): Random start, increments through set
    - Descending (D): Random start, decrements through set
    - Shuffle (Sh): Fixed random sequence
    - Random (R): Non-repeating selection (avoids consecutive duplicates)
  - Separate numerator and denominator controls with independent behaviors
  - Ctrl-side resolution ensuring unique harmonic ratios per synth client
- **Compact HRG User Interface**
  - [H] toggle button (replaces dice emoji 🎲)
  - Two-line layout: numerators (n:) and denominators (d:)
  - Minimal, space-efficient design
- **Deferred Parameter Application System**
  - "Apply Changes" button moved to control panel
  - Visual feedback with asterisk (*) for pending changes
  - Batched application of both musical parameters and HRG settings
  - Prevents accidental parameter broadcasting during adjustment

### Changed

- **Parameter Application Workflow**
  - HRG changes no longer broadcast immediately
  - All parameter changes now require explicit "Apply Changes" action
  - Improved user control over when changes affect distributed synths
- **HRG Interface Design**
  - Removed Range/HRG mode dropdown for frequency (HRG only)
  - Streamlined workflow with direct access to HRG controls
  - Replaced verbose labels with compact abbreviations (S/A/D/Sh/R)
- **Button Location**
  - "Apply Changes" moved from synthesis panel to control panel
  - Better organization of control functions

### Fixed

- **Parabolic Envelope System**
  - Intensity value of 0.00 now works correctly (was being replaced with 0.5)
  - Proper handling of falsy values in envelope calculations
  - Geometric mean calculation for frequency parabolic envelopes
- **HRG Temporal Behaviors**
  - Ascending/descending behaviors now work temporally as intended
  - Values progress through integer sets at EOC boundaries
  - Random behavior properly avoids consecutive duplicate values
- **Parameter Interference Bug**
  - Static frequency slider adjustments no longer interfere with HRG-generated
    values
  - Added checks to prevent broadcasting when HRG is controlling parameters

### Removed

- **Range/HRG Mode Selection**
  - Eliminated redundant dropdown for frequency parameters
  - Simplified workflow by making HRG the only randomization method for
    frequency
- **Immediate HRG Broadcasting**
  - Removed automatic parameter broadcasting on HRG input changes
  - All changes now go through deferred application system

### Technical Improvements

- **AudioWorklet Integration**
  - Enhanced vowel-synth.worklet.js with complete HRG support
  - Proper state tracking for temporal behaviors
  - Efficient ratio calculation and application
- **Network Protocol**
  - Optimized randomization config broadcasting
  - Better separation of immediate vs deferred parameter updates
- **Code Organization**
  - Cleaner separation between HRG logic and UI controls
  - Removed unused mode selection code
  - Simplified parameter broadcasting logic

### Documentation

- Updated README.md with comprehensive HRG system documentation
- Added Quick Start section covering HRG workflow
- Updated spec.md to reflect implementation status
- Marked Phase 4 deliverables as completed in implementation-plan.md
- Added file structure documentation for new synthesis worklet

## Previous Versions

Previous development was tracked through git commits and is documented in the
implementation plan and project specification files.
