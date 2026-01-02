"""
Tests for service layer modules.
"""

import pytest


class TestPayrollTaxCalculator:
    """Test payroll tax calculations."""

    def test_calculator_import(self):
        """Test that calculator can be imported."""
        from src.budget.tax_calculator import PayrollTaxCalculator
        calculator = PayrollTaxCalculator()
        assert calculator is not None

    def test_calculate_paycheck_single(self):
        """Test paycheck calculation for single filer."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="CA",
            tax_year=2024
        )

        result = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly"
        )

        # Result is a PaycheckBreakdown dataclass
        assert hasattr(result, 'gross')
        assert hasattr(result, 'federal_income_tax')
        assert hasattr(result, 'social_security')
        assert hasattr(result, 'medicare')
        assert result.gross == 3846.15
        assert result.federal_income_tax > 0
        assert result.social_security > 0

    def test_calculate_paycheck_with_deductions(self):
        """Test paycheck with pre-tax deductions."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="CA",
            tax_year=2024
        )

        result_no_deductions = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly"
        )

        result_with_deductions = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly",
            pretax_deductions={"401k": 500}
        )

        # Pre-tax deductions should reduce taxable income and thus federal tax
        assert result_with_deductions.federal_income_tax < result_no_deductions.federal_income_tax

    def test_calculate_annual_summary(self):
        """Test annual tax summary."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="CA",
            tax_year=2024
        )

        result = calculator.calculate_annual_summary(
            annual_gross=100000
        )

        # Result is a dict for annual summary
        assert "gross_income" in result
        assert "federal_income_tax" in result
        assert "net_income" in result
        assert result["net_income"] < result["gross_income"]

    def test_no_state_tax_states(self):
        """Test states with no income tax."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        # Texas has no state income tax
        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="TX",
            tax_year=2024
        )

        result = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly"
        )

        assert result.state_income_tax == 0


class TestSocialSecurityEstimator:
    """Test Social Security benefit estimation."""

    def test_estimator_import(self):
        """Test that estimator can be imported."""
        from src.budget.social_security import estimate_social_security_benefit
        assert estimate_social_security_benefit is not None

    def test_basic_estimate(self):
        """Test basic SS benefit estimate."""
        from src.budget.social_security import estimate_social_security_benefit

        result = estimate_social_security_benefit(
            annual_income=100000,
            current_age=45,
            claiming_age=67,
            birth_year=1980
        )

        # Result is a SocialSecurityEstimate dataclass
        assert hasattr(result, 'monthly_benefit_at_fra') or hasattr(result, 'monthly_benefit')
        assert hasattr(result, 'claiming_age')
        assert result.claiming_age == 67


class TestTriggersEngine:
    """Test allocation triggers evaluation."""

    def test_trigger_service_import(self):
        """Test that trigger service can be imported."""
        from src.services.triggers import TriggerEvaluator
        assert TriggerEvaluator is not None

    def test_trigger_evaluator_creation(self):
        """Test creating a trigger evaluator."""
        from src.services.triggers import TriggerEvaluator
        from src.database import get_database

        db = get_database()
        evaluator = TriggerEvaluator(db)
        assert evaluator is not None


class TestMonteCarloEngine:
    """Test Monte Carlo simulation engine."""

    def test_engine_import(self):
        """Test that engine can be imported."""
        from src.projections.engine import MonteCarloEngine
        assert MonteCarloEngine is not None

    def test_engine_methods(self):
        """Test that engine has expected methods."""
        from src.projections.engine import MonteCarloEngine

        engine = MonteCarloEngine()

        # Check for expected methods
        assert hasattr(engine, 'run_projection')
        assert hasattr(engine, 'calculate_fire_number')
        assert hasattr(engine, 'estimate_years_to_fire')

    def test_fire_calculation(self):
        """Test FIRE number calculation."""
        from src.projections.engine import MonteCarloEngine

        engine = MonteCarloEngine()

        fire_number = engine.calculate_fire_number(
            annual_spending=50000,
            withdrawal_rate=0.04
        )

        # FIRE number = annual_spending / withdrawal_rate
        assert fire_number == 1250000
