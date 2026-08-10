//! The CRT `lpReserved2` block is HOSTILE INPUT, and this file is where that is
//! proved.
//!
//! WHY THESE ARE BYTE-LEVEL AND NOT PROCESS-LEVEL. Every case here is a block
//! shape a real parent could hand us — truncated, over-declared, inconsistent,
//! or carrying a handle that is not what it claims. None of them is reachable by
//! spawning a well-behaved child, so a test that could only run behind a spawn
//! could never reach them at all. `acquire_from_block` takes the bytes and the
//! declared `cbReserved2` for exactly that reason.
//!
//! EVERY CASE ASSERTS ITS OWN REASON CODE, and where the refusal is about one
//! descriptor it asserts the SLOT INDEX too. "It refused" is not an assertion:
//! this parser has six ways to refuse and five of them would satisfy a test that
//! only checked `is_err()`.
//!
//! The table below is generated over, so
//! [`the_hostile_block_table_is_exactly_the_nine_named_cases`] pins both its
//! length and its member names by hand. A generator that silently produced zero
//! cases would otherwise make every sweep over it pass while testing nothing.

use std::cell::RefCell;
use std::fs::OpenOptions;
use std::os::windows::io::{IntoRawHandle, OwnedHandle};

use moe_windows_job_broker::{
    acquire_from_block, DescriptorError, DescriptorReason, HandleCalls, SystemHandles,
    INVALID_HANDLE, PIPE_FILE_TYPE, REQUIRED_DESCRIPTOR_COUNT,
};

#[test]
fn the_two_sentinels_the_parser_hardcodes_match_windows_sys() {
    // Both numbers are written as literals in production so the pure parser can
    // stay free of windows-sys, so both are pinned to the real declaration here.
    // PIPE_FILE_TYPE also has a `const` assertion in boundary.rs that fails the
    // BUILD; this is the belt to that braces, and it is the check that would
    // catch FILE_TYPE_CHAR (2) being reached for by mistake.
    assert_eq!(
        INVALID_HANDLE,
        windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE as isize,
        "the invalid-handle sentinel drifted from Win32"
    );
    assert_eq!(
        PIPE_FILE_TYPE,
        windows_sys::Win32::Storage::FileSystem::FILE_TYPE_PIPE,
        "the pipe file type drifted from Win32"
    );
    assert_ne!(
        PIPE_FILE_TYPE,
        windows_sys::Win32::Storage::FileSystem::FILE_TYPE_CHAR,
        "the pipe check would accept a character device"
    );
}

/// A handle value that is not zero and not `INVALID_HANDLE_VALUE`, so the
/// absence check passes it through, but that no case here ever lets reach
/// `GetFileType` — every table case refuses on block shape or on an absent slot
/// first. Using a plausible-looking value keeps the table honest about which
/// refusal is doing the work.
const FILLER: isize = 4;

/// Serialises a block the way the CRT lays one out: a `u32` count, then
/// `flag_bytes` per-descriptor flag bytes, then one pointer-sized handle each.
///
/// The three sizes are INDEPENDENT PARAMETERS on purpose. A real hostile block
/// is precisely one whose declared count disagrees with the bytes that follow,
/// so a builder that derived the count from the handle slice could not express
/// the cases this file exists to cover. This serialises; it does not parse, and
/// it shares no arithmetic with the production parser.
fn raw_block(declared_count: u32, flag_bytes: usize, handles: &[isize]) -> Vec<u8> {
    let mut bytes = declared_count.to_le_bytes().to_vec();
    bytes.extend(std::iter::repeat(0x09u8).take(flag_bytes));
    for handle in handles {
        bytes.extend((*handle as usize).to_le_bytes());
    }
    bytes
}

/// A well-formed six-descriptor block, 4 + 6 * (1 + size_of::<usize>()) bytes —
/// 58 on x64, which is what a real Node v24 parent produces.
fn six_slot_block(handles: [isize; REQUIRED_DESCRIPTOR_COUNT]) -> Vec<u8> {
    raw_block(REQUIRED_DESCRIPTOR_COUNT as u32, REQUIRED_DESCRIPTOR_COUNT, &handles)
}

fn declared(bytes: &[u8]) -> u16 {
    u16::try_from(bytes.len()).expect("a test block never exceeds cbReserved2's u16")
}

struct Case {
    name: &'static str,
    bytes: Vec<u8>,
    declared: u16,
    reason: DescriptorReason,
    slot: Option<u8>,
}

/// Every block-shape refusal, one case each.
///
/// Not one of these needs a real handle: the parser refuses on shape or on an
/// absent slot before it would ever ask the kernel what a handle is.
fn hostile_blocks() -> Vec<Case> {
    let full = six_slot_block([FILLER; REQUIRED_DESCRIPTOR_COUNT]);
    vec![
        Case {
            // cbReserved2 == 0 is how a parent that passed no extra descriptors
            // looks. The BYTES here are a perfectly good block, which is the
            // point: the declared size is authoritative, not what happens to be
            // in memory behind the pointer.
            name: "absent_when_cb_reserved2_is_zero",
            bytes: full.clone(),
            declared: 0,
            reason: DescriptorReason::BlockAbsent,
            slot: None,
        },
        Case {
            // A null `lpReserved2` reaches the parser as an empty slice.
            name: "absent_when_the_pointer_yields_no_bytes",
            bytes: Vec::new(),
            declared: 58,
            reason: DescriptorReason::BlockAbsent,
            slot: None,
        },
        Case {
            name: "too_short_to_even_read_the_count",
            bytes: vec![0, 0, 0],
            declared: 3,
            reason: DescriptorReason::BlockTooShortForCount,
            slot: None,
        },
        Case {
            // One byte short of the size its own count implies.
            name: "count_implies_more_than_cb_reserved2",
            bytes: full.clone(),
            declared: declared(&full) - 1,
            reason: DescriptorReason::CountExceedsBlock,
            slot: None,
        },
        Case {
            // cbReserved2 LIES UPWARD: it declares 58 while only 20 bytes exist.
            // Trusting the declaration here is a read past the end of the
            // parent's allocation, so the smaller of the two must win.
            name: "cb_reserved2_declares_more_than_was_supplied",
            bytes: full[..20].to_vec(),
            declared: 58,
            reason: DescriptorReason::CountExceedsBlock,
            slot: None,
        },
        Case {
            // 4 + u32::MAX * 9 must be computed WITHOUT wrapping to a small
            // number that would then fit inside 58 bytes.
            name: "count_of_u32_max_refuses_instead_of_overflowing",
            bytes: raw_block(u32::MAX, REQUIRED_DESCRIPTOR_COUNT, &[FILLER; REQUIRED_DESCRIPTOR_COUNT]),
            declared: 58,
            reason: DescriptorReason::CountExceedsBlock,
            slot: None,
        },
        Case {
            // Internally consistent, just too small: fd3/fd4/fd5 are not there
            // at all. This must NOT degrade to "acquire the five we got".
            name: "count_below_the_six_the_broker_requires",
            bytes: raw_block(5, 5, &[FILLER; 5]),
            declared: 49,
            reason: DescriptorReason::CountBelowRequired,
            slot: None,
        },
        Case {
            name: "slot_three_carries_a_zero_handle",
            bytes: six_slot_block([FILLER, FILLER, FILLER, 0, FILLER, FILLER]),
            declared: 58,
            reason: DescriptorReason::SlotHandleAbsent,
            slot: Some(3),
        },
        Case {
            name: "slot_five_carries_invalid_handle_value",
            bytes: six_slot_block([FILLER, FILLER, FILLER, FILLER, FILLER, -1]),
            declared: 58,
            reason: DescriptorReason::SlotHandleAbsent,
            slot: Some(5),
        },
    ]
}

#[test]
fn the_hostile_block_table_is_exactly_the_nine_named_cases() {
    // HAND-WRITTEN, not derived from the table. A count computed from the same
    // generator it is meant to police cannot detect the generator shrinking.
    let expected = [
        "absent_when_cb_reserved2_is_zero",
        "absent_when_the_pointer_yields_no_bytes",
        "cb_reserved2_declares_more_than_was_supplied",
        "count_below_the_six_the_broker_requires",
        "count_implies_more_than_cb_reserved2",
        "count_of_u32_max_refuses_instead_of_overflowing",
        "slot_five_carries_invalid_handle_value",
        "slot_three_carries_a_zero_handle",
        "too_short_to_even_read_the_count",
    ];
    let mut names: Vec<&str> = hostile_blocks().iter().map(|case| case.name).collect();
    names.sort_unstable();
    assert_eq!(names.len(), 9, "the hostile-block table changed size");
    assert_eq!(names, expected, "the hostile-block table changed membership");
}

#[test]
fn every_hostile_block_refuses_with_its_own_reason_and_slot() {
    let calls = SystemHandles;
    let cases = hostile_blocks();
    assert_eq!(cases.len(), 9, "a table that generated nothing would sweep vacuously");

    for case in cases {
        let error = acquire_from_block(&case.bytes, case.declared, &calls)
            .err()
            .unwrap_or_else(|| panic!("{} was accepted", case.name));
        assert_eq!(error.reason(), case.reason, "{} refused for the wrong reason", case.name);
        assert_eq!(error.slot(), case.slot, "{} named the wrong slot", case.name);
    }
}

#[test]
fn the_table_plus_the_type_check_reach_every_reason_in_the_vocabulary() {
    // The vocabulary is closed and its length is part of its type, so a new
    // variant fails to compile at `ALL` until a case here produces it.
    let mut produced: Vec<DescriptorReason> = hostile_blocks()
        .into_iter()
        .map(|case| case.reason)
        .chain([non_pipe_in_slot_three().reason(), close_that_the_kernel_refuses().reason()])
        .collect();
    produced.sort_unstable();
    produced.dedup();
    assert_eq!(produced, DescriptorReason::ALL.to_vec(), "a refusal reason is never produced");
}

/// Three anonymous pipes' worth of handle values, detached from the std wrappers
/// so exactly one owner exists — whoever the test hands them to closes them.
fn six_pipe_handles() -> [isize; REQUIRED_DESCRIPTOR_COUNT] {
    let mut handles = [0isize; REQUIRED_DESCRIPTOR_COUNT];
    for pair in 0..3 {
        let (reader, writer) = std::io::pipe().expect("an anonymous pipe must be creatable");
        handles[pair * 2] = detach(reader);
        handles[pair * 2 + 1] = detach(writer);
    }
    handles
}

/// A real handle that is NOT a pipe. `NUL` is `FILE_TYPE_CHAR`, which is the
/// value one off from `FILE_TYPE_PIPE` — precisely the confusion a hardcoded
/// literal in the parser would produce.
fn character_device_handle() -> isize {
    detach(OpenOptions::new().read(true).write(true).open("NUL").expect("NUL must open"))
}

fn detach<T: Into<OwnedHandle>>(owner: T) -> isize {
    owner.into().into_raw_handle() as isize
}

/// A delegating decorator over the production boundary that records which raw
/// values were closed, and can make ONE chosen close fail.
///
/// `file_type` forwards untouched, so the pipe check under test is always the
/// shipped one. Only `close_handle` is ever scripted, and only for the single
/// case that needs a failing close.
///
/// WHY THE FAILING CLOSE IS SCRIPTED RATHER THAN REAL. The obvious way to make a
/// close fail is to close the handle out from under its owner first. That works
/// exactly once and then poisons the whole suite: Windows REUSES handle values,
/// so the owner's doomed second close can land on a pipe another test — running
/// concurrently, since cargo tests are threaded — has just been given. It cost
/// two unrelated failures on the run that introduced it. Refusing at the seam
/// keeps the production logic under test (the error mapping, and first-error-
/// wins in `Descriptors::close`) while making the hazard unrepresentable.
struct Counting {
    inner: SystemHandles,
    closed: RefCell<Vec<isize>>,
    refuse_close_of: Option<isize>,
}

impl Counting {
    fn new() -> Self {
        Self { inner: SystemHandles, closed: RefCell::new(Vec::new()), refuse_close_of: None }
    }

    fn refusing_close_of(raw: isize) -> Self {
        Self { refuse_close_of: Some(raw), ..Self::new() }
    }

    /// How many times this exact raw value was closed. The DoD asks for a
    /// per-handle count, not a total: a total of six could be six closes of one
    /// handle.
    fn closes_of(&self, raw: isize) -> usize {
        self.closed.borrow().iter().filter(|value| **value == raw).count()
    }
}

impl HandleCalls for Counting {
    fn file_type(&self, raw: isize) -> Result<u32, u32> {
        self.inner.file_type(raw)
    }

    fn close_handle(&self, raw: isize) -> Result<(), u32> {
        self.closed.borrow_mut().push(raw);
        if self.refuse_close_of == Some(raw) {
            return Err(windows_sys::Win32::Foundation::ERROR_INVALID_HANDLE);
        }
        self.inner.close_handle(raw)
    }
}

fn non_pipe_in_slot_three() -> DescriptorError {
    let mut handles = six_pipe_handles();
    let device = character_device_handle();
    handles[3] = device;
    let bytes = six_slot_block(handles);
    let calls = Counting::new();

    let error = acquire_from_block(&bytes, 58, &calls)
        .err()
        .expect("a character device in a descriptor slot must be refused");

    // The three verified pipes were adopted and are closed exactly once each on
    // the refusal path. The device was never verified, so it was never adopted —
    // closing a handle whose identity we could not establish is the double-close
    // hazard, not tidiness.
    for pipe in &handles[..3] {
        assert_eq!(calls.closes_of(*pipe), 1, "an adopted pipe did not close exactly once");
    }
    assert_eq!(calls.closes_of(device), 0, "an unverified handle must never be adopted");
    // Slots 4 and 5 were never reached, so the test still owns them.
    let _ = calls.close_handle(handles[4]);
    let _ = calls.close_handle(handles[5]);
    let _ = calls.close_handle(device);
    error
}

#[test]
fn a_handle_that_is_not_a_pipe_is_refused_by_its_slot_index() {
    let error = non_pipe_in_slot_three();
    assert_eq!(error.reason(), DescriptorReason::SlotNotPipe);
    assert_eq!(error.slot(), Some(3), "the refusal must name the slot that was wrong");
}

#[test]
fn six_real_pipes_are_acquired_and_every_one_closes_exactly_once() {
    let handles = six_pipe_handles();
    let bytes = six_slot_block(handles);
    let calls = Counting::new();

    let descriptors = acquire_from_block(&bytes, 58, &calls).expect("six real pipes are valid");
    for handle in handles {
        assert_eq!(calls.closes_of(handle), 0, "a handle closed before acquisition finished");
    }

    descriptors.close().expect("closing six real pipes must succeed");
    for handle in handles {
        assert_eq!(calls.closes_of(handle), 1, "a descriptor did not close exactly once");
    }
}

#[test]
fn dropping_the_descriptors_without_closing_still_closes_each_exactly_once() {
    let handles = six_pipe_handles();
    let bytes = six_slot_block(handles);
    let calls = Counting::new();

    drop(acquire_from_block(&bytes, 58, &calls).expect("six real pipes are valid"));

    for handle in handles {
        assert_eq!(calls.closes_of(handle), 1, "the drop guard did not close exactly once");
    }
}

fn close_that_the_kernel_refuses() -> DescriptorError {
    let handles = six_pipe_handles();
    let bytes = six_slot_block(handles);
    let calls = Counting::refusing_close_of(handles[2]);

    let descriptors = acquire_from_block(&bytes, 58, &calls).expect("six real pipes are valid");
    let error = descriptors.close().expect_err("an unknown close outcome is not a success");

    // Every one of the six was still ATTEMPTED: a failure at slot 2 must not
    // skip the three after it, or they leak.
    for handle in handles {
        assert_eq!(calls.closes_of(handle), 1, "a descriptor was skipped or closed twice");
    }
    // The one the seam refused is genuinely still open, so the test closes it.
    calls.inner.close_handle(handles[2]).expect("the refused handle must still be closable");
    error
}

#[test]
fn a_close_the_kernel_refuses_is_surfaced_and_never_converted_to_success() {
    let error = close_that_the_kernel_refuses();
    assert_eq!(error.reason(), DescriptorReason::CloseFailed);
    assert_eq!(error.slot(), Some(2), "the failing close must name its slot");
    assert_eq!(
        error.code(),
        windows_sys::Win32::Foundation::ERROR_INVALID_HANDLE,
        "the operating system's code must survive to the caller unchanged"
    );
}
