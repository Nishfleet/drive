---------------------------- MODULE ConflictGuard ----------------------------
EXTENDS TLC

CONSTANTS RecheckQueue, RelearnBaseline

VARIABLES remote, queued, theirsDone, phase, previous, outcome

vars == <<remote, queued, theirsDone, phase, previous, outcome>>

Unknown == "unknown"

Init ==
    /\ remote = "old"
    /\ queued = TRUE
    /\ theirsDone = FALSE
    /\ phase = "unseen"
    /\ previous = Unknown
    /\ outcome = "pending"

MyUploadLands ==
    /\ queued
    /\ remote' = "mine"
    /\ queued' = FALSE
    /\ UNCHANGED <<theirsDone, phase, previous, outcome>>

TheirUploadLands ==
    /\ ~theirsDone
    /\ remote' = "theirs"
    /\ theirsDone' = TRUE
    /\ UNCHANGED <<queued, phase, previous, outcome>>

GuardMissesSave ==
    /\ phase = "unseen"
    /\ ~queued
    /\ phase' = "done"
    /\ outcome' = IF remote = "mine" THEN "unwatched" ELSE "lost"
    /\ UNCHANGED <<remote, queued, theirsDone, previous>>

GuardSightsSave ==
    /\ phase = "unseen"
    /\ queued
    /\ phase' = "readingBaseline"
    /\ UNCHANGED <<remote, queued, theirsDone, previous, outcome>>

BaselineRead ==
    /\ phase = "readingBaseline"
    /\ previous' = remote
    /\ phase' = "sighted"
    /\ UNCHANGED <<remote, queued, theirsDone, outcome>>

BaselineUnreadable ==
    /\ phase = "readingBaseline"
    /\ previous' = Unknown
    /\ phase' = "sighted"
    /\ UNCHANGED <<remote, queued, theirsDone, outcome>>

QueueRecheck ==
    /\ phase = "sighted"
    /\ phase' = "watching"
    /\ previous' = IF RecheckQueue /\ ~queued THEN Unknown ELSE previous
    /\ UNCHANGED <<remote, queued, theirsDone, outcome>>

QueueRecheckFails ==
    /\ RecheckQueue
    /\ phase = "sighted"
    /\ phase' = "watching"
    /\ previous' = Unknown
    /\ UNCHANGED <<remote, queued, theirsDone, outcome>>

RelearnStart ==
    /\ RelearnBaseline
    /\ phase = "watching"
    /\ previous = Unknown
    /\ queued
    /\ phase' = "relearning"
    /\ UNCHANGED <<remote, queued, theirsDone, previous, outcome>>

RelearnRead ==
    /\ phase = "relearning"
    /\ previous' = remote
    /\ phase' = "watching"
    /\ UNCHANGED <<remote, queued, theirsDone, outcome>>

GuardKeepsUpload ==
    /\ phase = "watching"
    /\ ~queued
    /\ remote = "mine"
    /\ phase' = "done"
    /\ outcome' = "uploaded"
    /\ UNCHANGED <<remote, queued, theirsDone, previous>>

GuardGivesUp ==
    /\ phase = "watching"
    /\ ~queued
    /\ remote # "mine"
    /\ remote = previous
    /\ phase' = "done"
    /\ outcome' = "dropped"
    /\ UNCHANGED <<remote, queued, theirsDone, previous>>

GuardKeepsConflictCopy ==
    /\ phase = "watching"
    /\ ~queued
    /\ remote # "mine"
    /\ remote # previous
    /\ phase' = "done"
    /\ outcome' = "conflictCopy"
    /\ UNCHANGED <<remote, queued, theirsDone, previous>>

Finished ==
    /\ phase = "done"
    /\ UNCHANGED vars

Next ==
    \/ MyUploadLands
    \/ TheirUploadLands
    \/ GuardMissesSave
    \/ GuardSightsSave
    \/ BaselineRead
    \/ BaselineUnreadable
    \/ QueueRecheck
    \/ QueueRecheckFails
    \/ RelearnStart
    \/ RelearnRead
    \/ GuardKeepsUpload
    \/ GuardGivesUp
    \/ GuardKeepsConflictCopy
    \/ Finished

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ remote \in {"old", "mine", "theirs"}
    /\ queued \in BOOLEAN
    /\ theirsDone \in BOOLEAN
    /\ phase \in {"unseen", "readingBaseline", "sighted", "watching", "relearning", "done"}
    /\ previous \in {"old", "mine", "theirs", Unknown}
    /\ outcome \in {"pending", "uploaded", "conflictCopy", "dropped", "unwatched", "lost"}

SightedSaveNeverDropped == outcome # "dropped"

SaveNeverDropped == outcome \notin {"dropped", "lost"}

=============================================================================
