use super::SqlNode;
use crate::planner::query_tools::QueryTools;
use crate::planner::sql_evaluator::MemberSymbol;
use crate::planner::sql_evaluator::SqlEvaluatorVisitor;
use crate::planner::sql_templates::PlanSqlTemplates;
use cubenativeutils::CubeError;
use std::any::Any;
use std::rc::Rc;

pub struct RootSqlNode {
    dimension_processor: Rc<dyn SqlNode>,
    time_dimesions_processor: Rc<dyn SqlNode>,
    measure_processor: Rc<dyn SqlNode>,
    cube_name_processor: Rc<dyn SqlNode>,
    cube_table_processor: Rc<dyn SqlNode>,
    default_processor: Rc<dyn SqlNode>,
}

impl RootSqlNode {
    pub fn new(
        dimension_processor: Rc<dyn SqlNode>,
        time_dimesions_processor: Rc<dyn SqlNode>,
        measure_processor: Rc<dyn SqlNode>,
        cube_name_processor: Rc<dyn SqlNode>,
        cube_table_processor: Rc<dyn SqlNode>,
        default_processor: Rc<dyn SqlNode>,
    ) -> Rc<Self> {
        Rc::new(Self {
            dimension_processor,
            time_dimesions_processor,
            measure_processor,
            cube_name_processor,
            cube_table_processor,
            default_processor,
        })
    }

    pub fn dimension_processor(&self) -> &Rc<dyn SqlNode> {
        &self.dimension_processor
    }

    pub fn measure_processor(&self) -> &Rc<dyn SqlNode> {
        &self.measure_processor
    }

    pub fn cube_name_processor(&self) -> &Rc<dyn SqlNode> {
        &self.cube_name_processor
    }

    pub fn default_processor(&self) -> &Rc<dyn SqlNode> {
        &self.default_processor
    }
}

impl SqlNode for RootSqlNode {
    fn to_sql(
        &self,
        visitor: &SqlEvaluatorVisitor,
        node: &Rc<MemberSymbol>,
        query_tools: Rc<QueryTools>,
        node_processor: Rc<dyn SqlNode>,
        templates: &PlanSqlTemplates,
    ) -> Result<String, CubeError> {
        let res = match node.as_ref() {
            MemberSymbol::Dimension(_) => self.dimension_processor.to_sql(
                visitor,
                node,
                query_tools.clone(),
                node_processor.clone(),
                templates,
            )?,
            MemberSymbol::TimeDimension(_) => self.time_dimesions_processor.to_sql(
                visitor,
                node,
                query_tools.clone(),
                node_processor.clone(),
                templates,
            )?,
            MemberSymbol::Measure(_) => self.measure_processor.to_sql(
                visitor,
                node,
                query_tools.clone(),
                node_processor.clone(),
                templates,
            )?,
            MemberSymbol::CubeName(_) => self.cube_name_processor.to_sql(
                visitor,
                node,
                query_tools.clone(),
                node_processor.clone(),
                templates,
            )?,
            MemberSymbol::CubeTable(_) => self.cube_table_processor.to_sql(
                visitor,
                node,
                query_tools.clone(),
                node_processor.clone(),
                templates,
            )?,
            _ => self.default_processor.to_sql(
                visitor,
                node,
                query_tools.clone(),
                node_processor.clone(),
                templates,
            )?,
        };
        Ok(res)
    }

    fn as_any(self: Rc<Self>) -> Rc<dyn Any> {
        self.clone()
    }

    fn childs(&self) -> Vec<Rc<dyn SqlNode>> {
        vec![
            self.dimension_processor.clone(),
            self.measure_processor.clone(),
            self.cube_name_processor.clone(),
            self.default_processor.clone(),
        ]
    }
}
