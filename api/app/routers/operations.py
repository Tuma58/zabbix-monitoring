import json

from fastapi import APIRouter

from app.deps import DbSession, ViewerUser
from app.errors import not_found
from app.models import Operation
from app.schemas import OperationOut

router = APIRouter()


@router.get("/{operation_id}", response_model=OperationOut)
def get_operation(operation_id: str, _: ViewerUser, db: DbSession) -> OperationOut:
    operation = db.get(Operation, operation_id)
    if operation is None:
        raise not_found("Operation not found")
    result = json.loads(operation.result_json or "{}")
    return OperationOut(
        id=operation.id,
        kind=operation.kind,
        state=operation.state,
        progress=operation.progress,
        error_code=operation.error_code,
        result=result if isinstance(result, dict) else {},
        links={"self": f"/api/v1/operations/{operation.id}"},
    )