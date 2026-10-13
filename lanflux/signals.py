"""Strict signaling schemas: file metadata and bytes belong only on the DataChannel."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, TypeAdapter


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class PairedSignal(StrictModel):
    pair_id: Annotated[StrictStr, Field(pattern=r"^[a-f0-9]{24}$")]


class Offer(PairedSignal):
    type: Literal["offer"]
    sdp: Annotated[StrictStr, Field(min_length=1, max_length=49152)]


class Answer(PairedSignal):
    type: Literal["answer"]
    sdp: Annotated[StrictStr, Field(min_length=1, max_length=49152)]


class Candidate(StrictModel):
    candidate: Annotated[StrictStr, Field(max_length=4096)] = ""
    sdpMid: Annotated[StrictStr, Field(max_length=256)] | None = None
    sdpMLineIndex: Annotated[StrictInt, Field(ge=0, le=65535)] | None = None
    usernameFragment: Annotated[StrictStr, Field(max_length=256)] | None = None


class Ice(PairedSignal):
    type: Literal["ice"]
    candidate: Candidate | None


class Ping(StrictModel):
    type: Literal["ping"]


signal_adapter = TypeAdapter(Annotated[Offer | Answer | Ice | Ping, Field(discriminator="type")])
